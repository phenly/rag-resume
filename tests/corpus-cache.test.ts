import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { calls: 0, fail: false };
vi.mock("@/lib/corpus", () => ({
  resolveCorpusDir: () => "dir",
  loadCorpus: async () => {
    state.calls++;
    if (state.fail) throw new Error("boom");
    return { marker: state.calls };
  },
}));

import { getCorpus, resetCorpusCache } from "@/lib/corpus-cache";

beforeEach(() => {
  state.calls = 0;
  state.fail = false;
  resetCorpusCache();
});

describe("getCorpus", () => {
  it("returns the cached object on the second call", async () => {
    const a = await getCorpus();
    const b = await getCorpus();
    expect(b).toBe(a);
    expect(state.calls).toBe(1);
  });

  it("does not cache a failure", async () => {
    state.fail = true;
    await expect(getCorpus()).rejects.toThrow("boom");
    state.fail = false;
    await expect(getCorpus()).resolves.toBeDefined();
    expect(state.calls).toBe(2);
  });
});
