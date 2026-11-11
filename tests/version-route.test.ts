import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { GET } from "@/app/api/version/route";
import { loadCorpus } from "@/lib/corpus";
import { resetCorpusCache } from "@/lib/corpus-cache";
import { config, proxy } from "@/proxy";
import * as retrievalLoad from "@/lib/retrieval/load";
import { RETRIEVAL_CONFIG_VERSION } from "@/lib/retrieval/pipeline";
import { WIDE_CONFIG_VERSION } from "@/lib/retrieval/pipeline-wide";
import { retrievalCorpusFixture } from "./fixtures/retrieval-corpus";
import { wideRetrievalCorpusFixture } from "./fixtures/wide-retrieval-corpus";
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
    expect(await response.json()).toEqual({ version: expected.version, approach: 'whole', retrievalConfigVersion: expect.stringMatching(/^[a-f0-9]{64}$/), retrieval: { status: 'missing' } });
    expect(expected.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("default version response retains its exact fields with wide configured", async () => {
    const f = await retrievalCorpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    vi.stubEnv("CVAI_RETRIEVAL_STRATEGY", "wide");
    const response = await GET(request());
    expect(await response.text()).toBe(JSON.stringify({ version: f.index.corpusVersion, approach: 'whole',
      retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION,
      retrieval: retrievalLoad.retrievalMetadata({ status: 'ready', index: f.index }) }));
  });

  it.each(['jev', 'wide'] as const)("detail reports strategy and active config version for %s", async strategy => {
    const f = await retrievalCorpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    vi.stubEnv("CVAI_RETRIEVAL_STRATEGY", strategy);
    const index = { ...f.index, units: wideRetrievalCorpusFixture().units };
    vi.spyOn(retrievalLoad, 'inspectRetrievalIndex').mockResolvedValue({ status: 'ready', index });
    const response = await GET(new Request("http://localhost/api/version?detail=1"));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: f.index.corpusVersion, approach: 'whole',
      retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION,
      retrieval: retrievalLoad.retrievalMetadata({ status: 'ready', index }),
      detail: { strategy, retrievalConfigVersion: strategy === 'wide' ? WIDE_CONFIG_VERSION : RETRIEVAL_CONFIG_VERSION,
        alwaysSuppliedCount: 5, overviewPresent: true } });
  });

  it("detail counts restricted about units and reports absent overview", async () => {
    const f = await retrievalCorpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    const units = wideRetrievalCorpusFixture().units.filter(unit => unit.document !== 'Career Overview');
    vi.spyOn(retrievalLoad, 'inspectRetrievalIndex').mockResolvedValue({ status: 'ready', index: { ...f.index, units } });
    const response = await GET(new Request("http://localhost/api/version?detail=1"));
    expect((await response.json()).detail).toMatchObject({ alwaysSuppliedCount: 3, overviewPresent: false });
  });

  it.each(['missing', 'stale', 'invalid'] as const)("detail reports null counts for %s index", async status => {
    const f = await corpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    vi.spyOn(retrievalLoad, 'inspectRetrievalIndex').mockResolvedValue({ status });
    const response = await GET(new Request("http://localhost/api/version?detail=1"));
    expect((await response.json()).detail).toEqual({ strategy: 'jev', retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION,
      alwaysSuppliedCount: null, overviewPresent: null });
  });

  it.each(['0', 'true', '01', ''])('does not opt in for detail=%s', async value => {
    const f = await corpusFixture();
    vi.stubEnv("CORPUS_DIR", f.dir);
    const response = await GET(new Request(`http://localhost/api/version?detail=${value}`));
    expect(await response.json()).not.toHaveProperty('detail');
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
