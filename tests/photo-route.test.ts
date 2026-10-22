import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadCorpus = vi.fn();
vi.mock("@/lib/corpus", () => ({ loadCorpus: (d: string) => loadCorpus(d), resolveCorpusDir: () => "dir" }));

import { GET } from "@/app/api/photo/route";

beforeEach(() => loadCorpus.mockReset());

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
    vi.spyOn(console, "error").mockImplementation(() => {});
    loadCorpus.mockImplementation(async () => { throw new Error("boom at /secret/path"); });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("/secret");
  });
});
