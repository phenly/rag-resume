import Anthropic from "@anthropic-ai/sdk";
import type { AskEvent } from "./events";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AskConfig = { apiKey: string; model: string; effort: Effort };

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function readAskConfig(env: Record<string, string | undefined> = process.env): AskConfig {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("ANTHROPIC_API_KEY is not set");
  const effort = env.RAG_EFFORT?.trim() as Effort | undefined;
  return {
    apiKey,
    model: env.RAG_MODEL?.trim() || "claude-opus-5-5",
    effort: effort && EFFORTS.includes(effort) ? effort : "medium",
  };
}

let last: Anthropic.Beta.BetaUsage | null = null;
/** Usage from the most recent finished stream (for scripts/ask.ts). */
export function lastUsage(): Anthropic.Beta.BetaUsage | null {
  return last;
}

export type AskStats = { eventTypes: string[]; deltaTypes: string[]; words: number };
let stats: AskStats = { eventTypes: [], deltaTypes: [], words: 0 };
/** Diagnostics for the most recent stream: stream event/delta types seen and visible word count. */
export function lastStats(): AskStats {
  return stats;
}

const CUT_OFF = "The answer was cut off. Try again.";

export async function* streamAnswer(
  question: string,
  system: Anthropic.Beta.BetaTextBlockParam[],
  config: AskConfig,
  client: Anthropic = new Anthropic({ apiKey: config.apiKey }),
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  last = null;
  const events = new Set<string>();
  const deltas = new Set<string>();
  let visible = "";
  stats = { eventTypes: [], deltaTypes: [], words: 0 };
  if (signal?.aborted) return; // client already gone: never start the API call

  let stream: ReturnType<Anthropic["beta"]["messages"]["stream"]> | undefined;
  const onAbort = () => stream?.abort();
  signal?.addEventListener("abort", onAbort);
  let finished = false;
  try {
    stream = client.beta.messages.stream({
      model: config.model,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: question }],
      output_config: { effort: config.effort },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for await (const ev of stream) {
      events.add(ev.type);
      if (ev.type === "content_block_delta") {
        deltas.add(ev.delta.type);
        if (ev.delta.type === "text_delta") {
          visible += ev.delta.text;
          yield { type: "text", text: ev.delta.text };
        }
      }
    }
    const msg = await stream.finalMessage();
    last = msg.usage;
    finished = true;
    if (msg.stop_reason === "refusal") yield { type: "done", status: "refused" };
    else if (msg.stop_reason === "end_turn" || msg.stop_reason === "stop_sequence")
      yield { type: "done", status: "complete" };
    else yield { type: "done", status: "incomplete" };
  } catch (err) {
    finished = true; // abort below only matters if the client left
    if (signal?.aborted) return; // client left; nobody is listening
    console.error("[ask] stream failed:", err);
    yield { type: "error", message: CUT_OFF };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Consumer stopped early (generator return/cancel) or client aborted: stop billing.
    if (!finished || signal?.aborted) stream?.abort();
    stats = {
      eventTypes: [...events],
      deltaTypes: [...deltas],
      words: visible.trim() ? visible.trim().split(/\s+/).length : 0,
    };
  }
}
