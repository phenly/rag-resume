import { CorpusError, type Corpus } from "@/lib/corpus";
import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { buildSystemPrompt } from "@/lib/prompt";
import { ConfigError, readAskConfig, streamAnswer } from "@/lib/claude";
import { encodeEvent, MAX_QUESTION_CHARS, type AskEvent } from "@/lib/events";
import { historySecret, parseHistory, signTurn } from "@/lib/history";

type System = ReturnType<typeof buildSystemPrompt>;
// The prompt is built once per cached corpus object (getCorpus caches successes only).
let cached: { corpus: Corpus; system: System } | null = null;

async function getSystem(): Promise<System> {
  const corpus = await getCorpus();
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
  const history = secret === null ? { ok: true as const, turns: [] } : parseHistory(rawHistory, secret);
  if (!history.ok) {
    if (history.reason === "signature") return json(400, "This conversation expired. Clear chat to start again.");
    if (history.reason === "limit") return json(400, "This conversation got too long. Clear chat to start again.");
    return json(400, "Send a JSON body with a question.");
  }

  try {
    const config = readAskConfig();
    const system = await getSystem();
    const events = streamAnswer(q, system, config, undefined, request.signal, history.turns);
    let answer = "";
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await events.next();
          if (done) controller.close();
          else {
            let ev: AskEvent = value;
            if (ev.type === "text") answer += ev.text;
            else if (ev.type === "done" && ev.status === "complete" && secret !== null && answer.trim() !== "") ev = { ...ev, sig: signTurn(q, answer, secret) };
            controller.enqueue(encoder.encode(encodeEvent(ev)));
          }
        } catch (err) {
          // Never error the stream without a terminal event.
          logServerError("[ask] stream generator threw", err);
          controller.enqueue(
            encoder.encode(encodeEvent({ type: "error", message: "The answer was cut off. Try again." })),
          );
          controller.close();
        }
      },
      cancel() {
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
