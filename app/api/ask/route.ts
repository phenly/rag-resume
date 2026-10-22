import { CorpusError, loadCorpus, resolveCorpusDir } from "@/lib/corpus";
import { buildSystemPrompt } from "@/lib/prompt";
import { ConfigError, readAskConfig, streamAnswer } from "@/lib/claude";
import { encodeEvent, MAX_QUESTION_CHARS } from "@/lib/events";

type System = ReturnType<typeof buildSystemPrompt>;
// Cache only a successful load; a failed load is retried on the next request.
let cached: System | null = null;

async function getSystem(): Promise<System> {
  if (!cached) cached = buildSystemPrompt(await loadCorpus(resolveCorpusDir()));
  return cached;
}

const json = (status: number, error: string) => Response.json({ error }, { status });

export async function POST(request: Request): Promise<Response> {
  let question: unknown;
  try {
    question = ((await request.json()) as { question?: unknown } | null)?.question;
  } catch {
    return json(400, "Send a JSON body with a question.");
  }
  if (typeof question !== "string" || question.trim() === "") {
    return json(400, "Ask a question first.");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return json(400, `Keep the question under ${MAX_QUESTION_CHARS} characters.`);
  }

  try {
    const config = readAskConfig();
    const system = await getSystem();
    const events = streamAnswer(question.trim(), system, config, undefined, request.signal);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await events.next();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(encodeEvent(value)));
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
      console.error("[ask] corpus error:", err.message, err.entryTitle ?? "", err.detail ?? "");
    } else {
      console.error("[ask] unexpected error:", err);
    }
    return json(500, "Something went wrong answering that. Try again.");
  }
}
