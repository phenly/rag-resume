import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCorpus } from "@/lib/corpus";
import { corpusSnapshot, corpusVersion } from "@/lib/corpus-version";
import { corpusFixture } from "./fixtures/corpus";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

describe("corpus version", () => {
  it("version changes when positioning notes change", async () => {
    const f = await corpusFixture();
    const before = await loadCorpus(f.dir);
    await f.put(f.dir, f.manifest.positioningNotes, "Lead with a different documented outcome.");
    expect((await loadCorpus(f.dir)).version).not.toBe(before.version);
  });

  it("version changes when a document changes", async () => {
    const f = await corpusFixture();
    const before = await loadCorpus(f.dir);
    await f.put(f.sourceDir, f.exported.documents[1].path, "A changed fictional project.");
    expect((await loadCorpus(f.dir)).version).not.toBe(before.version);
  });

  it("version unchanged by profile photo path rename when bytes are equal", async () => {
    const f = await corpusFixture();
    const before = await loadCorpus(f.dir);
    await f.put(f.dir, "renamed.png", f.photoBytes);
    await f.put(f.dir, f.manifest.profile, JSON.stringify({ ...f.profile, photo: "renamed.png" }));
    const after = await loadCorpus(f.dir);
    expect(after.photoPath).not.toBe(before.photoPath);
    expect(after.version).toMatch(/^[a-f0-9]{64}$/);
    expect(after.version).toBe(before.version);
  });

  it("hashes the specified ordered payload, with null for absent rules or photo", async () => {
    const f = await corpusFixture();
    const c = await loadCorpus(f.dir);
    const profile = { ...c.profile };
    delete profile.photo;
    const payload: unknown[] = [profile, sha(f.photoBytes), c.answerStyle, c.positioningNotes, c.globalRules, c.documents.map((d) => [d.title, d.text])];
    expect(c.version).toBe(sha(JSON.stringify(payload)));
    expect(corpusVersion(c, f.photoBytes)).toBe(c.version);
    payload[1] = null;
    payload[4] = null;
    expect(corpusVersion({ ...c, globalRules: undefined }, null)).toBe(sha(JSON.stringify(payload)));
  });

  it("tracks profile, photo bytes, answer style, global rules, and document titles and order", async () => {
    const f = await corpusFixture();
    const c = await loadCorpus(f.dir);
    for (const changed of [
      { ...c, profile: { ...c.profile, headline: "A different fictional headline" } },
      { ...c, answerStyle: "A different style" }, { ...c, globalRules: "A new restriction" },
      { ...c, documents: c.documents.map((d, i) => i === 0 ? { ...d, title: "Renamed" } : d) },
      { ...c, documents: [...c.documents].reverse() },
    ]) expect(corpusVersion(changed, f.photoBytes)).not.toBe(c.version);
    await f.put(f.dir, f.profile.photo, Buffer.from("different photo bytes"));
    expect((await loadCorpus(f.dir)).version).not.toBe(c.version);
  });

  it("corpus version is identical for vault and staged copies", async () => {
    const f = await corpusFixture();
    const vault = await loadCorpus(f.dir);
    const stagedDir = path.join(f.root, "staged output");
    // Isolate the script's original default destination, even during the red run.
    await f.put(f.root, "repo/scripts/stage-deploy-corpus.sh", await readFile("scripts/stage-deploy-corpus.sh"));
    const script = path.join(f.root, "repo/scripts/stage-deploy-corpus.sh");
    execFileSync("bash", [script, f.dir, stagedDir]);
    const manifest = JSON.parse(await readFile(path.join(stagedDir, "corpus.json"), "utf8"));
    expect(manifest.documents).toEqual([{ title: "Overview", path: "doc-1.md" }]);
    expect(manifest.documentsFrom).toBe("bot-export.json");
    const exported = JSON.parse(await readFile(path.join(stagedDir, manifest.documentsFrom), "utf8"));
    expect(exported.rules).toBe("global-rules.md");
    expect(exported.documents).toEqual(f.exported.documents.map((d, i) => ({ title: d.title, path: `doc-${i + 2}.md` })));
    // Staged content must be self-contained, with no remaining vault references.
    await rm(path.join(f.root, "vault"), { recursive: true });
    const staged = await loadCorpus(stagedDir);
    expect(staged.profile.photo).toBe("photo.png");
    expect(staged.documents).toEqual(vault.documents);
    expect(staged.globalRules).toBe(vault.globalRules);
    expect(staged.version).toBe(vault.version);
    expect(corpusSnapshot(staged)).toEqual(corpusSnapshot(vault));
  });

  it("snapshots component hashes and documents by title", async () => {
    const f = await corpusFixture();
    const c = await loadCorpus(f.dir);
    const snapshot = corpusSnapshot(c);
    expect(snapshot.version).toBe(c.version);
    expect(Object.keys(snapshot.files)).toEqual(["profile", "answerStyle", "positioningNotes", "globalRules"]);
    expect(snapshot.documents).toEqual(Object.fromEntries(c.documents.map((d) => [d.title, sha(d.text)])));
    for (const hash of Object.values(snapshot.files)) expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const updated = corpusSnapshot({ ...c, positioningNotes: "Changed notes" });
    expect(updated.files.positioningNotes).not.toBe(snapshot.files.positioningNotes);
    expect(updated.files.profile).toBe(snapshot.files.profile);
    expect(updated.documents).toEqual(snapshot.documents);
    expect(corpusSnapshot({ ...c, globalRules: undefined }).files.globalRules).not.toBe(snapshot.files.globalRules);
  });
});
