import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CorpusError, loadCorpus, resolveCorpusDir } from "@/lib/corpus";

const sampleDir = resolveCorpusDir({});

describe("corpus", () => {
  it("loads the sample corpus", async () => {
    const c = await loadCorpus(sampleDir);
    expect(c.profile.name).toBe("Jordan Example");
    expect(c.documents).toHaveLength(3);
    expect(c.profile.starterQuestions).toHaveLength(5);
  });

  it("redacts contact details in every document", async () => {
    const c = await loadCorpus(sampleDir);
    for (const d of c.documents) {
      for (const s of ["jordan.example@example.com", "jordan.alt@example.org", "010-4477", "Pelican Way"]) {
        expect(d.text).not.toContain(s);
      }
    }
  });

  it("keeps internal-only text for the prompt", async () => {
    const c = await loadCorpus(sampleDir);
    expect(c.documents.some((d) => d.text.includes("CANARY-PELICAN-7731"))).toBe(true);
  });

  it("defaults to sample-corpus when CORPUS_DIR is unset", () => {
    const dir = resolveCorpusDir({});
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir.endsWith("/sample-corpus")).toBe(true);
  });

  it("throws naming the entry when a document is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-"));
    await writeFile(path.join(dir, "profile.json"), JSON.stringify({ name: "X", headline: "", about: "", links: [], blurb: "", starterQuestions: [], breakItQuestions: [] }));
    await writeFile(path.join(dir, "notes.md"), "n");
    await writeFile(
      path.join(dir, "corpus.json"),
      JSON.stringify({ profile: "profile.json", positioningNotes: "notes.md", documents: [{ title: "Ghost", path: "nope.md" }] }),
    );
    const err = await loadCorpus(dir).catch((e) => e);
    expect(err).toBeInstanceOf(CorpusError);
    expect(err.entryTitle).toBe("Ghost");
    expect(err.message).toContain("Ghost");
    expect(err.message).not.toContain("/");
    expect(err.detail).toContain("nope.md");
  });

  const goodProfile = { name: "X", headline: "", about: "", links: [], blurb: "", starterQuestions: [], breakItQuestions: [] };
  async function tempCorpus(manifest: unknown, profile: unknown = goodProfile, notes = "n") {
    const dir = await mkdtemp(path.join(tmpdir(), "corpus-"));
    await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile));
    await writeFile(path.join(dir, "notes.md"), notes);
    await writeFile(path.join(dir, "corpus.json"), JSON.stringify(manifest));
    return dir;
  }
  const base = { profile: "profile.json", positioningNotes: "notes.md" };

  it("rejects a manifest entry with no path", async () => {
    const dir = await tempCorpus({ ...base, documents: [{ title: "A" }] });
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("rejects a null manifest", async () => {
    const dir = await tempCorpus(null);
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("rejects a profile missing starterQuestions", async () => {
    const { starterQuestions: _s, ...bad } = goodProfile;
    const dir = await tempCorpus({ ...base, documents: [] }, bad);
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("redacts contact details in positioning notes", async () => {
    const dir = await tempCorpus({ ...base, documents: [] }, goodProfile, "Lead with x. Mail me@example.com");
    const c = await loadCorpus(dir);
    expect(c.positioningNotes).not.toContain("me@example.com");
    expect(c.positioningNotes).toContain("[email removed]");
  });
});

describe("profile photo", () => {
  async function photoCorpus(photo: unknown, setup?: (dir: string, outside: string) => Promise<void>) {
    const root = await mkdtemp(path.join(tmpdir(), "photo-"));
    const dir = path.join(root, "corpus");
    const outside = path.join(root, "outside");
    await mkdir(dir);
    await mkdir(outside);
    const profile: Record<string, unknown> = { name: "X", headline: "", about: "", links: [], blurb: "", starterQuestions: [], breakItQuestions: [] };
    if (photo !== undefined) profile.photo = photo;
    await writeFile(path.join(dir, "profile.json"), JSON.stringify(profile));
    await writeFile(path.join(dir, "notes.md"), "n");
    await writeFile(path.join(dir, "corpus.json"), JSON.stringify({ profile: "profile.json", positioningNotes: "notes.md", documents: [] }));
    await setup?.(dir, outside);
    return { dir, root };
  }

  it("sample corpus has a validated photoPath", async () => {
    const c = await loadCorpus(sampleDir);
    expect(c.profile.photo).toBe("placeholder-avatar.png");
    expect(c.photoPath?.endsWith("/sample-corpus/placeholder-avatar.png")).toBe(true);
    expect(path.isAbsolute(c.photoPath!)).toBe(true);
  });

  it("leaves photoPath undefined when there is no photo", async () => {
    const { dir } = await photoCorpus(undefined);
    expect((await loadCorpus(dir)).photoPath).toBeUndefined();
  });

  it("accepts an uppercase extension", async () => {
    const { dir } = await photoCorpus("me.PNG", async (d) => writeFile(path.join(d, "me.PNG"), "x"));
    expect((await loadCorpus(dir)).photoPath?.endsWith("/me.PNG")).toBe(true);
  });

  it("rejects an empty or non-string photo", async () => {
    for (const bad of ["", "  ", 5]) {
      const { dir } = await photoCorpus(bad);
      await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
    }
  });

  it("rejects ../ escapes", async () => {
    const { dir } = await photoCorpus("../outside/outside.png", async (_d, o) => writeFile(path.join(o, "outside.png"), "x"));
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("rejects a symlink pointing outside the corpus", async () => {
    const { dir } = await photoCorpus("link.png", async (d, o) => {
      await writeFile(path.join(o, "real.png"), "x");
      await symlink(path.join(o, "real.png"), path.join(d, "link.png"));
    });
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("rejects unsupported extensions", async () => {
    const { dir } = await photoCorpus("me.svg", async (d) => writeFile(path.join(d, "me.svg"), "<svg/>"));
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("rejects a directory named like an image", async () => {
    const { dir } = await photoCorpus("me.png", async (d) => mkdir(path.join(d, "me.png")));
    await expect(loadCorpus(dir)).rejects.toBeInstanceOf(CorpusError);
  });

  it("missing file: path only in detail", async () => {
    const { dir } = await photoCorpus("gone.png");
    const err = await loadCorpus(dir).catch((e) => e);
    expect(err).toBeInstanceOf(CorpusError);
    expect(err.message).not.toContain(dir);
    expect(err.message).not.toContain("gone.png");
    expect(err.detail).toContain("gone.png");
  });
});
