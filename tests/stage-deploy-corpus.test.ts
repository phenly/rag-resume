import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { corpusFixture } from "./fixtures/corpus";

/** Runs a copy of the script inside an isolated repo, so its default deploy-corpus/ is synthetic. */
async function stageFixture() {
  const f = await corpusFixture();
  await f.put(f.root, "repo/scripts/stage-deploy-corpus.sh", await readFile("scripts/stage-deploy-corpus.sh"));
  const script = path.join(f.root, "repo/scripts/stage-deploy-corpus.sh");
  const run = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8" });
  const exists = (file: string) => access(file).then(() => true, () => false);
  return { ...f, run, exists, defaultOut: path.join(f.root, "repo/deploy-corpus") };
}

describe("stage-deploy-corpus output guard", () => {
  it("stages into a new directory", async () => {
    const f = await stageFixture();
    const out = path.join(f.root, "fresh");
    const result = f.run(f.dir, out);
    expect(result.status, result.stderr).toBe(0);
    expect(await f.exists(path.join(out, "corpus.json"))).toBe(true);
  });

  it("replaces the default deploy-corpus/ even when it holds unrelated files", async () => {
    const f = await stageFixture();
    await f.put(f.defaultOut, "stale.txt", "old");
    const result = f.run(f.dir);
    expect(result.status, result.stderr).toBe(0);
    expect(await f.exists(path.join(f.defaultOut, "stale.txt"))).toBe(false);
    expect(await f.exists(path.join(f.defaultOut, "corpus.json"))).toBe(true);
  });

  it("replaces a previous staging output", async () => {
    const f = await stageFixture();
    const out = path.join(f.root, "previous");
    expect(f.run(f.dir, out).status).toBe(0);
    await f.put(out, "doc-99.md", "stale doc");
    const result = f.run(f.dir, out);
    expect(result.status, result.stderr).toBe(0);
    expect(await f.exists(path.join(out, "doc-99.md"))).toBe(false);
  });

  it.each([
    ["an unrelated non-empty directory", { "notes.txt": "mine" }],
    ["an unrelated markdown directory", { "diary.md": "mine" }],
    ["a corpus.json beside other markdown files", { "corpus.json": "{}", "doc-1.md": "d", "diary.md": "mine" }],
    ["a corpus.json beside a subdirectory", { "corpus.json": "{}", "sub/inner.txt": "mine" }],
    ["a directory without a corpus.json", {}],
  ])("refuses %s and leaves it untouched", async (_name, files) => {
    const f = await stageFixture();
    const out = path.join(f.root, "precious");
    await f.put(out, ".keep", "");
    for (const [file, value] of Object.entries(files)) await f.put(out, file, value);
    const result = f.run(f.dir, out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing");
    expect(await f.exists(path.join(out, ".keep"))).toBe(true);
    for (const file of Object.keys(files)) expect(await f.exists(path.join(out, file))).toBe(true);
    expect(await f.exists(path.join(f.dir, "corpus.json"))).toBe(true);
  });

  it("refuses when the output is the source, however it is spelled", async () => {
    const f = await stageFixture();
    for (const out of [f.dir, `${f.dir}/`, `${f.dir}/../corpus`]) {
      const result = f.run(f.dir, out);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Refusing");
      expect(await f.exists(path.join(f.dir, "corpus.json"))).toBe(true);
    }
  });
});
