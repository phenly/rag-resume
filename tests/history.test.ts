import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  historySecret,
  parseHistory,
  signTurn,
  type Turn,
} from "@/lib/history";

const S = "secret-a";
const turn = (q = "q", a = "a", secret = S): Turn => ({ question: q, answer: a, sig: signTurn(q, a, secret) });

describe("history", () => {
  it("round-trips signed turns", () => {
    const turns = [turn("q1", "a1"), turn("q2", "a2")];
    expect(parseHistory(turns, S)).toEqual({ ok: true, turns });
  });

  it("treats undefined as empty history", () => {
    expect(parseHistory(undefined, S)).toEqual({ ok: true, turns: [] });
  });

  it("rejects a changed answer or question", () => {
    expect(parseHistory([{ ...turn(), answer: "changed" }], S)).toEqual({ ok: false, reason: "signature" });
    expect(parseHistory([{ ...turn(), question: "changed" }], S)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects a turn signed with another secret", () => {
    expect(parseHistory([turn("q", "a", "secret-b")], S)).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects garbage signatures without throwing", () => {
    for (const sig of ["", "zz", "abc", "0".repeat(200)]) {
      expect(parseHistory([{ ...turn(), sig }], S)).toEqual({ ok: false, reason: "signature" });
    }
  });

  it("limits turns and total characters", () => {
    const many = Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => turn());
    expect(parseHistory(many, S)).toEqual({ ok: false, reason: "limit" });
    expect(parseHistory(Array.from({ length: MAX_HISTORY_TURNS }, () => turn()), S).ok).toBe(true);
    const atLimit = turn("q", "a".repeat(MAX_HISTORY_CHARS - 1));
    expect(parseHistory([atLimit], S).ok).toBe(true);
    const over = turn("q", "a".repeat(MAX_HISTORY_CHARS));
    expect(parseHistory([over], S)).toEqual({ ok: false, reason: "limit" });
  });

  it("rejects the wrong shape", () => {
    for (const raw of [
      "x",
      {},
      null,
      [null],
      [{ question: "q", answer: "a" }],
      [{ question: 1, answer: "a", sig: "s" }],
      [{ question: "q", answer: {}, sig: "s" }],
    ]) {
      expect(parseHistory(raw, S)).toEqual({ ok: false, reason: "shape" });
    }
  });

  it("uses HISTORY_SECRET when set, else a stable random per-process secret", () => {
    expect(historySecret({ HISTORY_SECRET: " abc " })).toBe("abc");
    const a = historySecret({});
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(historySecret({ HISTORY_SECRET: "" })).toBe(a);
  });
});
