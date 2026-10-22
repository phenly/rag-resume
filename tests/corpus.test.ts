import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
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
  });
});
