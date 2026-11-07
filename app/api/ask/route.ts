import { CorpusError, resolveCorpusDir, type Corpus } from "@/lib/corpus";
import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { buildSystemPrompt, buildRagSystemPrompt } from "@/lib/prompt";
import { ConfigError, readAskConfig, streamAnswer } from "@/lib/claude";
import { encodeEvent, MAX_QUESTION_CHARS, type AskEvent } from "@/lib/events";
import { historySecret, parseHistory, signTurn } from "@/lib/history";

import { configuredApproach } from "@/lib/retrieval/load";
import { prepareProductionRagPipeline, createWholeFallbackGuard, generatorContextLimit, UNAVAILABLE_ANSWER } from "@/lib/retrieval/production";
import type { AskConfig } from "@/lib/claude";
import type { Turn } from "@/lib/history";

type Prepared = Awaited<ReturnType<typeof prepareProductionRagPipeline>>;
let ragCache: { corpus: Corpus; key: string; prepared: Promise<Prepared> } | undefined;
function getRag(corpus: Corpus, config: AskConfig): Promise<Prepared> {
  // Credentials never enter diagnostics; changing them invalidates prepared clients.
  const key = JSON.stringify([resolveCorpusDir(), config.model, config.apiKey, process.env.VOYAGE_API_KEY, process.env.TYPESAFE_API_KEY]);
  if (ragCache?.corpus === corpus && ragCache.key === key) return ragCache.prepared;
  const prepared = prepareProductionRagPipeline({ corpus, corpusDir: resolveCorpusDir(), config });
  ragCache = { corpus, key, prepared };
  void prepared.then(result => { if (!result.ready && ragCache?.prepared === prepared) ragCache = undefined; }, () => { if (ragCache?.prepared === prepared) ragCache = undefined; });
  return prepared;
}

async function* answerEvents(question: string, corpus: Corpus, config: AskConfig, signal: AbortSignal, history: Turn[]): AsyncGenerator<AskEvent> {
  if (signal.aborted) return;
  let system = getSystem(corpus);
  if (configuredApproach() === 'rag') {
    if (generatorContextLimit() === undefined) {
      yield { type: 'text', text: UNAVAILABLE_ANSWER };
      yield { type: 'done', status: 'complete' };
      return;
    }
    try {
      const prepared = await getRag(corpus, config);
      if (signal.aborted) return;
      const result = await prepared.resolve({ question, verifiedHistory: history, signal });
      if (result.kind === 'cancelled' || signal.aborted) return;
      if (result.kind === 'route') {
        yield { type: 'text', text: result.answer };
        yield { type: 'done', status: 'complete' };
        return;
      }
      if (result.kind === 'evidence') {
        system = buildRagSystemPrompt(corpus, result.selected);
      }
    } catch {
      // Preparation failures are retried next request; never expose provider errors.
    }
    if (signal.aborted) return;
    {
      const eligible = await createWholeFallbackGuard({ corpus, corpusDir: resolveCorpusDir(), config })({ question, history, signal, system });
      if (signal.aborted) return;
      if (!eligible.eligible) {
        yield { type: 'text', text: UNAVAILABLE_ANSWER };
        yield { type: 'done', status: 'complete' };
        return;
      }
    }
  }
  if (!signal.aborted) yield* streamAnswer(question, system, config, undefined, signal, history);
}

type System = ReturnType<typeof buildSystemPrompt>;
// The prompt is built once per cached corpus object (getCorpus caches successes only).
let cached: { corpus: Corpus; system: System } | null = null;

function getSystem(corpus: Corpus): System {
  if (!cached || cached.corpus !== corpus) cached = { corpus, system: buildSystemPrompt(corpus) };
  return cached.system;
}

let warnedNoSecret = false;
function warnNoSecretOnce() {
  if (warnedNoSecret) return;
  warnedNoSecret = true;
  logServerError("[ask] follow-up history disabled", new Error("HISTORY_SECRET is not set"));
}

const json = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request): Promise<Response> {
  const blocked = guardLocalRequest(request, { requireJson: true });
  if (blocked) return blocked;
  let question: unknown;
  let rawHistory: unknown;
  try {
    const body = (await request.json()) as { question?: unknown; history?: unknown } | null;
    if (body && Object.hasOwn(body, "approach")) return json(400, "The answer approach is configured by the server.");
    question = body?.question;
    rawHistory = body?.history;
  } catch {
    return json(400, "Send a JSON body with a question.");
  }
  if (typeof question !== "string") return json(400, "Ask a question first.");
  const q = question.trim();
  if (q === "") return json(400, "Ask a question first.");
  if (q.length > MAX_QUESTION_CHARS) {
    return json(400, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);
  }
  const secret = historySecret();
  if (secret === null) warnNoSecretOnce();
  try {
    const corpus = await getCorpus();
    const history = secret === null ? { ok: true as const, turns: [] } : parseHistory(rawHistory, secret, corpus.version);
    if (!history.ok) {
      if (history.reason === "signature") return json(400, "This conversation expired. Clear chat to start again.");
      if (history.reason === "limit") return json(400, "This conversation got too long. Clear chat to start again.");
      return json(400, "Send a JSON body with a question.");
    }
    const config = readAskConfig();
    configuredApproach(); // Reject invalid configuration before opening the stream.
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) cancellation.abort();
    const events = answerEvents(q, corpus, config, cancellation.signal, history.turns);
    let answer = "";
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await events.next();
          if (done) {
            request.signal.removeEventListener('abort', abort);
            controller.close();
          }
          else {
            let ev: AskEvent = value;
            if (ev.type === "text") answer += ev.text;
            else if (ev.type === "done" && ev.status === "complete" && secret !== null && answer.trim() !== "") ev = { ...ev, sig: signTurn(q, answer, secret, corpus.version) };
            controller.enqueue(encoder.encode(encodeEvent(ev)));
          }
        } catch (err) {
          // Never error the stream without a terminal event.
          logServerError("[ask] stream generator threw", err);
          controller.enqueue(
            encoder.encode(encodeEvent({ type: "error", message: "The answer was cut off. Try again." })),
          );
          request.signal.removeEventListener('abort', abort);
          controller.close();
        }
      },
      cancel() {
        cancellation.abort();
        request.signal.removeEventListener('abort', abort);
        void events.return(undefined);
      },
    });
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      return json(500, "The server has no Anthropic API key configured.");
    }
    if (err instanceof CorpusError) {
      logServerError("[ask] corpus error", err);
    } else {
      logServerError("[ask] unexpected error", err);
    }
    return json(500, "Something went wrong answering that. Try again.");
  }
}
