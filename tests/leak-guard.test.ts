import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const dirs: string[] = [];

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(opts: { marker?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leak-guard-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, ".githooks"));
  for (const f of ["scripts/leak-guard.sh", ".githooks/pre-commit"]) {
    // Missing source file is the RED state: the commit then runs no guard.
    if (fs.existsSync(path.join(ROOT, f))) {
      fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
      fs.chmodSync(path.join(dir, f), 0o755);
    }
  }
  git(dir, "config", "core.hooksPath", ".githooks");
  if (opts.marker !== undefined) {
    fs.writeFileSync(path.join(dir, ".leak-guard.local"), opts.marker + "\n");
  }
  return dir;
}

function commit(dir: string, paths: string[]) {
  git(dir, "add", "-f", "--", ...paths);
  return git(dir, "commit", "-m", "test", "--", ...paths);
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("leak guard", () => {
  it("blocks a local marker", () => {
    const dir = makeRepo({ marker: "ZEBRA-MARKER-01" });
    fs.writeFileSync(path.join(dir, "a.txt"), "hello zebra-marker-01 there\n");
    const r = commit(dir, ["a.txt"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("local:1");
    expect(r.stderr.toLowerCase()).not.toContain("zebra");
  });

  it("blocks an Anthropic key without a local file", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "key = sk-ant-" + "x".repeat(30) + "\n");
    const r = commit(dir, ["a.txt"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("builtin:api-key");
    expect(r.stderr).not.toContain("sk-ant-");
  });

  it("blocks a staged .env.local", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, ".env.local"), "FOO=bar\n");
    const r = commit(dir, [".env.local"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("builtin:env-file");
  });

  it("blocks a staged symlink", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "real.txt"), "x\n");
    fs.symlinkSync("real.txt", path.join(dir, "link.txt"));
    const r = commit(dir, ["link.txt"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("builtin:symlink");
  });

  it("allows committing the guard itself", () => {
    const dir = makeRepo({ marker: ["unrelated", "marker", "77"].join("-") });
    fs.copyFileSync(path.join(ROOT, "tests/leak-guard.test.ts"), path.join(dir, "leak-guard.test.ts"));
    fs.mkdirSync(path.join(dir, "tests"));
    fs.renameSync(path.join(dir, "leak-guard.test.ts"), path.join(dir, "tests/leak-guard.test.ts"));
    const r = commit(dir, ["scripts/leak-guard.sh", ".githooks/pre-commit", "tests/leak-guard.test.ts"]);
    expect(r.stderr).not.toContain("leak-guard:");
    expect(r.status).toBe(0);
  });

  it("passes a clean commit", () => {
    const dir = makeRepo({ marker: "ZEBRA-MARKER-01" });
    fs.writeFileSync(path.join(dir, "a.txt"), "nothing to see\n");
    const r = commit(dir, ["a.txt"]);
    expect(r.stderr).not.toContain("leak-guard:");
    expect(r.status).toBe(0);
  });
});
