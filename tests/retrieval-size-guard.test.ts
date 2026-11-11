import { describe, expect, it } from "vitest";
import type { Turn } from "@/lib/history";
import { fitsGeneratorContext, requestByteBound } from "@/lib/retrieval/size-guard";

describe("requestByteBound", () => {
  it("requestByteBound counts multi-byte characters as bytes", () => {
    expect(requestByteBound({ system: [], question: "é" })).toBe(2);
  });

  it("sums every system block, question, and history question and answer, excluding signatures", () => {
    const history: readonly Turn[] = [
      { question: "é", answer: "🌙", sig: "signature-is-not-model-context" },
      { question: "abc", answer: "界", sig: "another-signature" },
    ];
    expect(requestByteBound({ system: [{ text: "ab" }, { text: "界" }], question: "🌙", history })).toBe(21);
  });

  it("handles omitted or empty history and empty text", () => {
    expect(requestByteBound({ system: [], question: "" })).toBe(0);
    expect(requestByteBound({ system: [{ text: "" }], question: "", history: [] })).toBe(0);
    expect(requestByteBound({ system: [{ text: "rules" }], question: "ask" })).toBe(8);
  });
});

describe("fitsGeneratorContext", () => {
  it("rejects the specified large request", () => {
    expect(fitsGeneratorContext({ byteBound: 997_000, maxTokens: 2500, limit: 1_000_000 })).toBe(false);
  });

  it("accepts the specified small request", () => {
    expect(fitsGeneratorContext({ byteBound: 100_000, maxTokens: 2500, limit: 1_000_000 })).toBe(true);
  });

  it("includes exactly 2000 of headroom and accepts equality", () => {
    expect(fitsGeneratorContext({ byteBound: 995_500, maxTokens: 2500, limit: 1_000_000 })).toBe(true);
    expect(fitsGeneratorContext({ byteBound: 995_501, maxTokens: 2500, limit: 1_000_000 })).toBe(false);
  });
});
