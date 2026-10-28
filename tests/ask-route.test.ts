import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventParser, type AskEvent } from "@/lib/events";
import { signTurn } from "@/lib/history";

let fakeEvents: AskEvent[] = [
  { type: "text", text: "Hello" },
  { type: "done", status: "complete" },
];

const streamSpy = vi.fn();
const SECRET = "test-secret";

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
      streamAnswer: async function* (...args: unknown[]) {
        streamSpy(...args);
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
  streamSpy.mockClear();
  vi.stubEnv("HISTORY_SECRET", SECRET);
  fakeEvents = [
    { type: "text", text: "Hello" },
    { type: "done", status: "complete" },
  ];
  process.env.CORPUS_DIR = "sample-corpus";
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
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
    expect(createEventParser()(text)).toEqual([
      { type: "text", text: "Hello" },
      { type: "done", status: "complete", sig: signTurn("What has Jordan built?", "Hello", SECRET) },
    ]);
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

  it("rejects a foreign Host, a mismatched Origin and a non-JSON content type", async () => {
    const { POST } = await loadRoute();
    const mk = (headers: Record<string, string>) =>
      new Request("http://127.0.0.1:3000/api/ask", {
        method: "POST",
        headers,
        body: JSON.stringify({ question: "hi" }),
      });
    const json = { "content-type": "application/json" };
    expect((await POST(mk({ ...json, host: "evil.example" }))).status).toBe(403);
    expect((await POST(mk({ ...json, host: "127.0.0.1:3000", origin: "http://evil.example" }))).status).toBe(403);
    expect((await POST(mk({ "content-type": "text/plain", host: "127.0.0.1:3000" }))).status).toBe(415);
    const ok = await POST(mk({ ...json, host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }));
    expect(ok.status).toBe(200);
    await ok.text();
  });

  it("signs a complete answer", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ question: " Q one? " }));
    const events = createEventParser()(await res.text());
    expect(events.at(-1)).toEqual({ type: "done", status: "complete", sig: signTurn("Q one?", "Hello", SECRET) });
  });

  it("does not sign incomplete answers", async () => {
    fakeEvents = [
      { type: "text", text: "Hel" },
      { type: "done", status: "incomplete" },
    ];
    const { POST } = await loadRoute();
    const events = createEventParser()(await (await POST(post({ question: "Q?" }))).text());
    expect(events.at(-1)).toEqual({ type: "done", status: "incomplete" });
  });

  it("rejects forged history without calling the model", async () => {
    const { POST } = await loadRoute();
    const forged = [{ question: "q1", answer: "edited", sig: signTurn("q1", "original", SECRET) }];
    for (const sig of [forged[0].sig, "zz", "", "00"]) {
      const res = await POST(post({ question: "Q?", history: [{ ...forged[0], sig }] }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("This conversation expired. Clear chat to start again.");
    }
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("rejects history signed under a different secret", async () => {
    const { POST } = await loadRoute();
    const history = [{ question: "q1", answer: "a1", sig: signTurn("q1", "a1", "other-secret") }];
    const res = await POST(post({ question: "Q?", history }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This conversation expired. Clear chat to start again.");
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversize history", async () => {
    const { POST } = await loadRoute();
    const shape = await POST(post({ question: "Q?", history: "nope" }));
    expect(shape.status).toBe(400);
    expect((await shape.json()).error).toBe("Send a JSON body with a question.");
    const turn = { question: "q", answer: "a", sig: signTurn("q", "a", SECRET) };
    const limit = await POST(post({ question: "Q?", history: Array(7).fill(turn) }));
    expect(limit.status).toBe(400);
    expect((await limit.json()).error).toBe("Send a shorter conversation.");
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("passes verified history to the model", async () => {
    const { POST } = await loadRoute();
    const history = [{ question: "q1", answer: "a1", sig: signTurn("q1", "a1", SECRET) }];
    const res = await POST(post({ question: "Q?", history }));
    expect(res.status).toBe(200);
    await res.text();
    expect(streamSpy).toHaveBeenCalledTimes(1);
    expect(streamSpy.mock.calls[0][0]).toBe("Q?");
    expect(streamSpy.mock.calls[0][5]).toEqual(history);
  });
});
