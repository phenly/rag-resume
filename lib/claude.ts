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

const CUT_OFF = "The answer was cut off. Try again.";

export async function* streamAnswer(
  question: string,
  system: Anthropic.Beta.BetaTextBlockParam[],
  config: AskConfig,
  client: Anthropic = new Anthropic({ apiKey: config.apiKey }),
  signal?: AbortSignal,
): AsyncGenerator<AskEvent> {
  last = null;
  const stream = client.beta.messages.stream({
    model: config.model,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: question }],
    output_config: { effort: config.effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  const onAbort = () => stream.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        yield { type: "text", text: ev.delta.text };
      }
    }
    const msg = await stream.finalMessage();
    last = msg.usage;
    if (msg.stop_reason === "refusal") yield { type: "done", status: "refused" };
    else if (msg.stop_reason === "max_tokens") yield { type: "done", status: "incomplete" };
    else yield { type: "done", status: "complete" };
  } catch (err) {
    if (signal?.aborted) return; // client left; nobody is listening
    console.error("[ask] stream failed:", err);
    yield { type: "error", message: CUT_OFF };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) stream.abort();
  }
}
