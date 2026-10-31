import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { GET } from "@/app/api/version/route";
import { loadCorpus } from "@/lib/corpus";
import { resetCorpusCache } from "@/lib/corpus-cache";
import { config, proxy } from "@/proxy";
import { corpusFixture } from "./fixtures/corpus";

beforeEach(() => resetCorpusCache());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetCorpusCache();
});
const request = () => new Request("http://localhost/api/version");

describe("GET /api/version", () => {
  it("returns the loaded corpus version, no-store", async () => {
    const f = await corpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    const expected = await loadCorpus(f.dir);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ version: expected.version });
    expect(expected.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns a safe corpus error with no-store on load failure", async () => {
    const f = await corpusFixture();
    vi.stubEnv("CORPUS_DIR", `${f.dir}/missing`);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "corpus" });
  });

  it("is behind the existing proxy gate using the invite cookie", () => {
    vi.stubEnv("INVITE_TOKENS", "test-invite");
    const url = "http://localhost/api/version";
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    expect(proxy(new NextRequest(url)).status).toBe(404);
    expect(proxy(new NextRequest(url, { headers: { cookie: "invite=wrong" } })).status).toBe(404);
    const allowed = proxy(new NextRequest(url, { headers: { cookie: "invite=test-invite" } }));
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects foreign hosts and origins", async () => {
    expect((await GET(new Request("http://foreign.example/api/version"))).status).toBe(403);
    expect((await GET(new Request("http://localhost/api/version", { headers: { origin: "http://foreign.example" } }))).status).toBe(403);
  });
});
