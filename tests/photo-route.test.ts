import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let impl: () => Promise<unknown> = async () => ({});
const loadCorpus = { mockReset: () => { impl = async () => ({}); }, mockResolvedValue: (v: unknown) => { impl = async () => v; }, fail: (m: string) => { impl = async () => { throw new Error(m); }; } };
vi.mock("@/lib/corpus", () => ({ loadCorpus: () => impl(), resolveCorpusDir: () => "dir" }));

import { GET as rawGET } from "@/app/api/photo/route";
import { resetCorpusCache } from "@/lib/corpus-cache";

const req = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:3000/api/photo", { headers });
const GET = (r: Request = req()) => rawGET(r);

beforeEach(() => {
  loadCorpus.mockReset();
  resetCorpusCache();
});

describe("GET /api/photo", () => {
  it("404s when the corpus has no photo", async () => {
    loadCorpus.mockResolvedValue({ profile: {}, positioningNotes: "", documents: [] });
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No photo." });
  });

  it("serves the photo with its content type and nosniff", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "photo-")), "a.png");
    writeFileSync(file, Buffer.from([137, 80, 78, 71]));
    loadCorpus.mockResolvedValue({ profile: {}, positioningNotes: "", documents: [], photoPath: file });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect((await res.arrayBuffer()).byteLength).toBe(4);
  });

  it("returns a generic 500 without leaking paths", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    loadCorpus.fail("boom at /secret/path");
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("/secret");
  });

  it("rejects a foreign Host and a mismatched Origin", async () => {
    expect((await GET(req({ host: "evil.example" }))).status).toBe(403);
    expect((await GET(req({ host: "127.0.0.1:3000", origin: "http://evil.example" }))).status).toBe(403);
  });
});
