import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { photoVersion } from "@/lib/photo-version";

const dir = mkdtempSync(path.join(tmpdir(), "photo-version-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("photoVersion", () => {
  it("is stable for the same file and path-free", async () => {
    const p = path.join(dir, "a.jpg");
    writeFileSync(p, "abc");
    const t = await photoVersion(p);
    expect(await photoVersion(p)).toBe(t);
    expect(t).toMatch(/^[a-f0-9]{10}$/);
    expect(t).not.toContain("/");
  });

  it("changes when mtime changes", async () => {
    const p = path.join(dir, "b.jpg");
    writeFileSync(p, "abc");
    utimesSync(p, 1000, 1000);
    const before = await photoVersion(p);
    utimesSync(p, 2000, 2000);
    expect(await photoVersion(p)).not.toBe(before);
  });

  it("changes when size changes", async () => {
    const p = path.join(dir, "c.jpg");
    writeFileSync(p, "abc");
    utimesSync(p, 1000, 1000);
    const before = await photoVersion(p);
    writeFileSync(p, "abcdef");
    utimesSync(p, 1000, 1000);
    expect(await photoVersion(p)).not.toBe(before);
  });
});
