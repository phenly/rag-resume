import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventParser, type AskEvent } from "@/lib/events";

const fakeEvents: AskEvent[] = [
  { type: "text", text: "Hello" },
  { type: "done", status: "complete" },
];

async function loadRoute(opts: { configThrows?: boolean; genThrows?: boolean } = {}) {
  vi.resetModules();
  vi.doMock("@/lib/claude", async () => {
    class ConfigError extends Error {}
    return {
      ConfigError,
      readAskConfig: () => {
        if (opts.configThrows) throw new ConfigError("no key at /secret/path");
        return { apiKey: "k", model: "m", effort: "medium" };
      },
      streamAnswer: async function* () {
        if (opts.genThrows) throw new Error("gen boom");
        for (const e of fakeEvents) yield e;
      },
    };
  });
  return import("@/app/api/ask/route");
}

const post = (body: unknown) =>
  new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

let tmp: string | undefined;
beforeEach(() => {
  process.env.CORPUS_DIR = "sample-corpus";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("POST /api/ask", () => {
  it("rejects blank and oversize questions", async () => {
    const { POST } = await loadRoute();
    for (const q of ["", "   ", "x".repeat(1001)]) {
      const res = await POST(post({ question: q }));
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ question: 5 }))).status).toBe(400);
  });

  it("streams NDJSON events", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ question: "What has Jordan built?" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(createEventParser()(text)).toEqual(fakeEvents);
  });

  it("ends the body with an error event if the generator throws", async () => {
    const { POST } = await loadRoute({ genThrows: true });
    const res = await POST(post({ question: "hi" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(createEventParser()(text)).toEqual([
      { type: "error", message: "The answer was cut off. Try again." },
    ]);
  });

  it("trims before checking length", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ question: "  " + "x".repeat(1000) + "  " }));
    expect(res.status).toBe(200);
    await res.text();
  });

  it("returns 500 with a safe message when the key is missing", async () => {
    const { POST } = await loadRoute({ configThrows: true });
    const res = await POST(post({ question: "hi" }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("/");
    expect(JSON.parse(body).error).toBe("The server has no Anthropic API key configured.");
  });

  it("hides corpus paths on a corpus error", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "rag-broken-"));
    writeFileSync(path.join(tmp, "corpus.json"), "{ not json");
    process.env.CORPUS_DIR = tmp;
    const { POST } = await loadRoute();
    const res = await POST(post({ question: "hi" }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain(tmp);
    expect(body).not.toContain(path.basename(tmp));
    expect(JSON.parse(body).error).toBe("Something went wrong answering that. Try again.");
  });
});
