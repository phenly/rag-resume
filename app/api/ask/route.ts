import { CorpusError, type Corpus } from "@/lib/corpus";
import { getCorpus } from "@/lib/corpus-cache";
import { logServerError } from "@/lib/log";
import { guardLocalRequest } from "@/lib/request-guard";
import { buildSystemPrompt } from "@/lib/prompt";
import { ConfigError, readAskConfig, streamAnswer } from "@/lib/claude";
import { encodeEvent, MAX_QUESTION_CHARS } from "@/lib/events";

type System = ReturnType<typeof buildSystemPrompt>;
// The prompt is built once per cached corpus object (getCorpus caches successes only).
let cached: { corpus: Corpus; system: System } | null = null;

async function getSystem(): Promise<System> {
  const corpus = await getCorpus();
  if (!cached || cached.corpus !== corpus) cached = { corpus, system: buildSystemPrompt(corpus) };
  return cached.system;
}

const json = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request): Promise<Response> {
  const blocked = guardLocalRequest(request, { requireJson: true });
  if (blocked) return blocked;
  let question: unknown;
  try {
    question = ((await request.json()) as { question?: unknown } | null)?.question;
  } catch {
    return json(400, "Send a JSON body with a question.");
  }
  if (typeof question !== "string") return json(400, "Ask a question first.");
  const q = question.trim();
  if (q === "") return json(400, "Ask a question first.");
  if (q.length > MAX_QUESTION_CHARS) {
    return json(400, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);
  }

  try {
    const config = readAskConfig();
    const system = await getSystem();
    const events = streamAnswer(q, system, config, undefined, request.signal);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await events.next();
          if (done) controller.close();
          else controller.enqueue(encoder.encode(encodeEvent(value)));
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
