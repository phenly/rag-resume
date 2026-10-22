import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ConfigError, readAskConfig, streamAnswer, type AskConfig } from "@/lib/claude";
import type { AskEvent } from "@/lib/events";

const config: AskConfig = { apiKey: "k", model: "claude-opus-5-5", effort: "medium" };
const system = [{ type: "text", text: "sys" }] as Anthropic.Beta.BetaTextBlockParam[];

function fakeClient(opts: { deltas?: string[]; stopReason?: string; throwAfter?: boolean }) {
  const captured: { params?: Record<string, unknown> } = {};
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          captured.params = params;
          return {
            async *[Symbol.asyncIterator]() {
              for (const t of opts.deltas ?? []) {
                yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
                yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "" } };
              }
              if (opts.throwAfter) throw new Error("boom: secret detail");
            },
            finalMessage: async () => ({
              stop_reason: opts.stopReason ?? "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
            abort: () => {},
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, captured };
}

async function collect(it: AsyncIterable<AskEvent>) {
  const out: AskEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("streamAnswer", () => {
  it("sends model, effort, fallbacks and system", async () => {
    const { client, captured } = fakeClient({ deltas: ["a"] });
    await collect(streamAnswer("Q?", system, config, client));
    const p = captured.params!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.max_tokens).toBe(4000);
    expect(p.system).toBe(system);
    expect(p.messages).toEqual([{ role: "user", content: "Q?" }]);
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    for (const k of ["thinking", "temperature", "top_p", "top_k"]) expect(p).not.toHaveProperty(k);
  });

  it("yields text events then done/complete", async () => {
    const { client } = fakeClient({ deltas: ["Hel", "lo"] });
    expect(await collect(streamAnswer("Q", system, config, client))).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "done", status: "complete" },
    ]);
  });

  it("marks max_tokens as incomplete", async () => {
    const { client } = fakeClient({ deltas: ["x"], stopReason: "max_tokens" });
    const out = await collect(streamAnswer("Q", system, config, client));
    expect(out.at(-1)).toEqual({ type: "done", status: "incomplete" });
  });

  it("marks refusal as refused", async () => {
    const { client } = fakeClient({ deltas: [], stopReason: "refusal" });
    const out = await collect(streamAnswer("Q", system, config, client));
    expect(out).toEqual([{ type: "done", status: "refused" }]);
  });

  it("emits error event when the stream fails after chunks", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ deltas: ["a", "b"], throwAfter: true });
    const out = await collect(streamAnswer("Q", system, config, client));
    expect(out).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "error", message: "The answer was cut off. Try again." },
    ]);
    expect(JSON.stringify(out)).not.toContain("secret");
    spy.mockRestore();
  });
});

describe("readAskConfig", () => {
  it("defaults to opus 5.5 / medium", () => {
    expect(readAskConfig({ ANTHROPIC_API_KEY: "k" })).toEqual({
      apiKey: "k",
      model: "claude-opus-5-5",
      effort: "medium",
    });
  });

  it("throws ConfigError without a key", () => {
    expect(() => readAskConfig({})).toThrow(ConfigError);
    expect(() => readAskConfig({ ANTHROPIC_API_KEY: "  " })).toThrow(ConfigError);
  });
});
