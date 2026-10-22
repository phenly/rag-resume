import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { ConfigError, lastStats, readAskConfig, streamAnswer, type AskConfig } from "@/lib/claude";
import type { AskEvent } from "@/lib/events";

const config: AskConfig = { apiKey: "k", model: "claude-opus-5-5", effort: "medium" };
const system = [{ type: "text", text: "sys" }] as Anthropic.Beta.BetaTextBlockParam[];

function fakeClient(opts: { deltas?: string[]; stopReason?: string; throwAfter?: boolean; throwSync?: boolean }) {
  const captured: { params?: Record<string, unknown>; aborts: number; started: number } = { aborts: 0, started: 0 };
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          captured.params = params;
          captured.started++;
          if (opts.throwSync) throw new Error("sync boom");
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
            abort: () => {
              captured.aborts++;
            },
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

describe("streamAnswer robustness", () => {
  it("maps pause_turn to incomplete", async () => {
    const { client } = fakeClient({ deltas: ["x"], stopReason: "pause_turn" });
    const out = await collect(streamAnswer("Q", system, config, client));
    expect(out.at(-1)).toEqual({ type: "done", status: "incomplete" });
  });

  it("maps stop_sequence to complete", async () => {
    const { client } = fakeClient({ stopReason: "stop_sequence" });
    expect(await collect(streamAnswer("Q", system, config, client))).toEqual([
      { type: "done", status: "complete" },
    ]);
  });

  it("emits exactly one error when stream() throws synchronously", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ throwSync: true });
    expect(await collect(streamAnswer("Q", system, config, client))).toEqual([
      { type: "error", message: "The answer was cut off. Try again." },
    ]);
    spy.mockRestore();
  });

  it("aborts the upstream stream when the consumer stops early", async () => {
    const { client, captured } = fakeClient({ deltas: ["a", "b", "c"] });
    for await (const e of streamAnswer("Q", system, config, client)) {
      expect(e.type).toBe("text");
      break; // same path as ReadableStream cancel -> generator.return()
    }
    expect(captured.aborts).toBe(1);
  });

  it("does not start the API call when the signal is already aborted", async () => {
    const { client, captured } = fakeClient({ deltas: ["a"] });
    const ac = new AbortController();
    ac.abort();
    expect(await collect(streamAnswer("Q", system, config, client, ac.signal))).toEqual([]);
    expect(captured.started).toBe(0);
  });

  it("records stats: visible words and delta types", async () => {
    const { client } = fakeClient({ deltas: ["one two ", "three"] });
    await collect(streamAnswer("Q", system, config, client));
    expect(lastStats().words).toBe(3);
    expect(lastStats().deltaTypes).toEqual(expect.arrayContaining(["text_delta"]));
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
