import { spawnSync } from "node:child_process";
import { access, chmod, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "@/lib/corpus";
import { corpusSnapshot } from "@/lib/corpus-version";
import { diffSnapshots, type Snapshot } from "@/scripts/corpus-report";
import { corpusFixture } from "./fixtures/corpus";

const snapshot = (changes: Partial<Snapshot> = {}): Snapshot => ({
  version: "version-one",
  files: { profile: "p", answerStyle: "a", positioningNotes: "n", globalRules: "r" },
  chunks: { "EX-1": { title: "First project", hash: "one" } },
  ...changes,
});

describe("diffSnapshots", () => {
  it("diffSnapshots reports added, changed, removed chunks", () => {
    const old = snapshot({ chunks: {
      "EX-1": { title: "Old title", hash: "old" },
      "EX-2": { title: "Removed project", hash: "two" },
      "EX-4": { title: "Unchanged project", hash: "four" },
    } });
    const next = snapshot({ version: "version-two", chunks: {
      "EX-1": { title: "Updated project", hash: "new" },
      "EX-3": { title: "Added project", hash: "three" },
      "EX-4": { title: "Unchanged project", hash: "four" },
    } });
    expect(diffSnapshots(old, next)).toEqual([
      "changed EX-1 — Updated project",
      "added EX-3 — Added project",
      "removed EX-2 — Removed project",
    ]);
  });

  it("reports changed positioning notes by name", () => {
    const old = snapshot();
    expect(diffSnapshots(old, snapshot({ files: { ...old.files, positioningNotes: "new" } })))
      .toEqual(["changed file: positioning notes"]);
  });

  it("no changes", () => {
    expect(diffSnapshots(snapshot(), snapshot())).toEqual(["no changes"]);
  });

  it("reports the other file labels and title-only edits", () => {
    const old = snapshot();
    expect(diffSnapshots(old, snapshot({
      files: { ...old.files, answerStyle: "new-a", profile: "new-p", globalRules: "new-r" },
      chunks: { "EX-1": { title: "Renamed project", hash: "one" } },
    }))).toEqual([
      "changed EX-1 — Renamed project",
      "changed file: answer style",
      "changed file: profile",
      "changed file: global rules",
    ]);
  });
});

function report(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/corpus-report.ts", ...args], {
    encoding: "utf8", cwd: process.cwd(),
  });
}

describe("corpus-report CLI", () => {
  it("loads the corpus, copies export chunks, writes a snapshot, and compares it", async () => {
    const f = await corpusFixture();
    const chunks = snapshot().chunks;
    await f.put(f.sourceDir, "bot-export.json", JSON.stringify({ ...f.exported, chunks }));
    const published = path.join(f.dir, "published.json");
    const corpus = await loadCorpus(f.dir);
    const written = report(f.dir, "--write", published);
    expect(written.status, written.stderr).toBe(0);
    expect(written.stdout).toBe(`version ${corpus.version}\n`);
    expect(JSON.parse(await readFile(published, "utf8"))).toEqual({
      version: corpus.version, files: corpusSnapshot(corpus).files, chunks,
    });
    const same = report(f.dir, "--against", published);
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toBe(`version ${corpus.version}\nno changes\n`);
    await f.put(f.dir, f.manifest.positioningNotes, "Lead with another documented outcome.");
    const changed = report(f.dir, "--against", published);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout.split("\n").slice(1)).toEqual(["changed file: positioning notes", ""]);
    // An ordinary report must never advance the published snapshot.
    expect(JSON.parse(await readFile(published, "utf8")).version).toBe(corpus.version);
  });

  it("accepts career-source's list-form chunks and keys them by ID", async () => {
    const f = await corpusFixture();
    const list = [{ id: "EX-1", title: "First project", file: "Example", hash: "one" }];
    await f.put(f.sourceDir, "bot-export.json", JSON.stringify({ ...f.exported, chunks: list }));
    const published = path.join(f.dir, "published.json");
    const written = report(f.dir, "--write", published);
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(await readFile(published, "utf8")).chunks).toEqual({ "EX-1": { title: "First project", hash: "one" } });
  });

  it("fails loudly on missing or malformed chunks instead of reporting no changes", async () => {
    const f = await corpusFixture();
    for (const chunks of [undefined, null, [{ title: "No id", hash: "x" }], { "EX-1": { title: "Missing hash" } }]) {
      await f.put(f.sourceDir, "bot-export.json", JSON.stringify({ ...f.exported, chunks }));
      const result = report(f.dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("chunks");
    }
  });

  it("rejects invalid arguments and does not overwrite a malformed baseline", async () => {
    const f = await corpusFixture();
    await f.put(f.sourceDir, "bot-export.json", JSON.stringify({ ...f.exported, chunks: {} }));
    const published = path.join(f.dir, "published.json");
    await f.put(f.dir, "published.json", "{broken");
    const result = report(f.dir, "--against", published, "--write", published);
    expect(result.status).toBe(1);
    expect(await readFile(published, "utf8")).toBe("{broken");
    for (const args of [[], [f.dir, "--write"], [f.dir, "--unknown"]]) {
      expect(report(...args).status).toBe(1);
    }
  });
});

/** Only local stubs run: no network, source export, deployment, or real credentials. */
async function shellFixture() {
  const f = await corpusFixture();
  const repo = path.join(f.root, "repo");
  const bin = path.join(repo, "bin");
  const vault = path.join(f.root, "vault with spaces");
  const corpus = path.join(vault, "Coding/rag-resume/corpus");
  const tmp = path.join(repo, "tmp");
  const executable = async (base: string, name: string, script: string) => {
    await f.put(base, name, script);
    await chmod(path.join(base, name), 0o755);
  };
  for (const name of ["publish.sh", "corpus-status.sh", "live-version.sh"]) {
    await executable(repo, `scripts/${name}`, await readFile(`scripts/${name}`, "utf8"));
  }
  await f.put(corpus, "keep.txt", "Pat Example's synthetic corpus.");
  await f.put(tmp, ".keep", "");
  await f.put(repo, ".env.deploy", "IGNORE=unused\nINVITE_PAT=test-token\nINVITE_SECOND=wrong-token\n");
  await executable(bin, "career-source", `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == "\${FAIL_AT:-}" ]]; then exit 1; fi
if [[ "$1" == export-bot ]]; then
  while [[ "$1" != --out ]]; do shift; done
  mkdir -p "$2"
  printf 'synthetic export\\n' > "$2/exported.txt"
  echo 'Exporter progress'
fi
`);
  await executable(bin, "npx", `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
[[ -f "$3/keep.txt" && -f "$3/career/exported.txt" ]]
echo 'version source-version'
if [[ " $* " == *' --against '* ]]; then echo 'changed EX-1 — First project'; fi
`);
  await executable(repo, "scripts/stage-deploy-corpus.sh", `#!/usr/bin/env bash
printf 'stage %s\\n' "$1" >> "$CALLS"
echo 'Staged synthetic corpus'
`);
  await executable(bin, "vercel", "#!/usr/bin/env bash\necho 'Unexpected deployment' >&2\nexit 99\n");
  await executable(bin, "curl", `#!/usr/bin/env bash
set -eu
printf 'curl\\n' >> "$CALLS"
printf '%s\\n' "$@" > "$CURL_ARGS"
if [[ "\${CURL_FAIL:-}" == 1 ]]; then exit 22; fi
printf '%s' "\${LIVE_BODY:-}"
`);
  const calls = path.join(repo, "calls.txt");
  const curlArgs = path.join(repo, "curl-args.txt");
  const run = (name: string, args: string[] = [], overrides: Record<string, string | undefined> = {}) =>
    spawnSync("bash", [path.join(repo, "scripts", name), ...args], {
      encoding: "utf8", cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VAULT: vault,
        TMPDIR: tmp, CALLS: calls, CURL_ARGS: curlArgs, SITE_URL: "https://example.invalid",
        LIVE_BODY: '{"version":"source-version"}', ...overrides },
    });
  return { ...f, repo, corpus, tmp, calls, curlArgs, run };
}

describe("publishing shell scripts (offline)", () => {
  it("publish --no-deploy lints, exports, reports, and stages in order", async () => {
    const f = await shellFixture();
    const result = f.run("publish.sh", ["--no-deploy"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Staged. Not deployed (--no-deploy).");
    const calls = (await readFile(f.calls, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("lint --source ");
    expect(calls[1]).toContain(`export-bot --source `);
    expect(calls[1]).toContain(`--out ${f.corpus}/career`);
    expect(calls[2]).toBe(`tsx scripts/corpus-report.ts ${f.corpus}`);
    expect(calls[3]).toBe(`stage ${f.corpus}`);
    await expect(access(path.join(f.corpus, "published.json"))).rejects.toThrow();
  });

  it("publish --no-deploy uses the published baseline when present", async () => {
    const f = await shellFixture();
    await f.put(f.corpus, "published.json", JSON.stringify(snapshot()));
    const result = f.run("publish.sh", ["--no-deploy"]);
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(f.calls, "utf8")).toContain(`--against ${f.corpus}/published.json`);
    expect(JSON.parse(await readFile(path.join(f.corpus, "published.json"), "utf8"))).toEqual(snapshot());
  });

  it.each(["lint", "export-bot"])("publish stops at a failing %s", async (step) => {
    const f = await shellFixture();
    expect(f.run("publish.sh", ["--no-deploy"], { FAIL_AT: step }).status).toBe(1);
    const calls = await readFile(f.calls, "utf8");
    expect(calls).not.toContain("tsx");
    expect(calls).not.toContain("stage ");
  });

  it("live-version uses the first invite and never prints it", async () => {
    const f = await shellFixture();
    const result = f.run("live-version.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("source-version\n");
    expect(result.stderr).not.toContain("test-token");
    const args = await readFile(f.curlArgs, "utf8");
    expect(args).toContain("Cookie: invite=test-token");
    expect(args).toContain("https://example.invalid/api/version");
    expect(args).not.toContain("wrong-token");
  });

  it("live-version fails on HTTP errors, invalid responses, or missing invites", async () => {
    const f = await shellFixture();
    for (const overrides of [{ CURL_FAIL: "1" }, { LIVE_BODY: "not JSON" },
      { LIVE_BODY: "{}" }, { LIVE_BODY: '{"version":""}' }, { LIVE_BODY: '{"version":42}' }]) {
      const result = f.run("live-version.sh", [], overrides);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("test-token");
    }
    await f.put(f.repo, ".env.deploy", "IGNORE=unused\n");
    expect(f.run("live-version.sh").status).toBe(1);
  });

  it("status exports into a temporary copy and reports current without touching the corpus", async () => {
    const f = await shellFixture();
    await f.put(f.corpus, "published.json", JSON.stringify(snapshot({ version: "source-version" })));
    const result = f.run("corpus-status.sh");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("live source-version\npublished source-version\nsource now source-version\ncurrent\n");
    await expect(access(path.join(f.corpus, "career"))).rejects.toThrow();
    expect(await readdir(f.tmp)).toEqual([".keep"]);
  });

  it("status prints changes when live is unreachable and handles no published snapshot", async () => {
    const f = await shellFixture();
    await f.put(f.corpus, "published.json", JSON.stringify(snapshot()));
    const result = f.run("corpus-status.sh", [], { CURL_FAIL: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("live unreachable\npublished version-one\nsource now source-version\nchanged EX-1 — First project\n");
    const fresh = await shellFixture();
    const first = fresh.run("corpus-status.sh");
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("live source-version\npublished none\nsource now source-version\n");
    expect(first.stdout).toContain("changed EX-1 — First project");
  });
});
