import { describe, expect, it } from "vitest";
import type { Corpus } from "@/lib/corpus";
import type { RetrievalUnit } from "@/lib/retrieval/extract";
import { buildSharedPromptPrefix, buildWideSystemPrompt, renderRetrievalEvidence } from "@/lib/prompt";

const corpus: Corpus = {
  version: "fictional-wide-test",
  profile: {
    name: "Robin Fiction", headline: "Imaginary systems engineer",
    about: "Builds fictional observatories.", links: [], blurb: "Fictional archive.",
    starterQuestions: [], breakItQuestions: [],
  },
  answerStyle: "Use short sentences.", positioningNotes: "Explain scope.",
  globalRules: "Never invent a customer.",
  documents: [{ title: "Fictional archive", text: "WHOLE-CORPUS-ONLY-CANARY" }],
};

function unit(id: string, promptText: string, kind: RetrievalUnit["kind"] = "entry"): RetrievalUnit {
  return {
    id, kind, document: "Fictional archive", title: id, promptText,
    searchText: promptText.split("\n\nAnswerer instructions")[0],
    indexedHash: "a".repeat(64), promptHash: "b".repeat(64),
  };
}

const always: readonly RetrievalUnit[] = [unit("about:fictional", "Robin built imaginary observatories.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: Keep observatory names generic.\n- Positioning: Explain the fictional scope.", "about")];
const retrieved: readonly RetrievalUnit[] = [unit("FICTION-ONE", "Designed a fictional telescope.")];
const heading = "# Career context supplied with every answer\n\n";

describe("buildWideSystemPrompt", () => {
  it("caches the prefix and always-supplied block together and leaves retrieved evidence uncached", () => {
    const blocks = buildWideSystemPrompt(corpus, always, retrieved);
    const prefix = buildSharedPromptPrefix(corpus);
    expect(blocks).toHaveLength(prefix.length + 2);
    expect(blocks.slice(0, prefix.length)).toEqual(prefix);
    expect(blocks.filter(block => block.cache_control !== undefined)).toEqual([blocks.at(-2)]);
    expect(blocks.at(-2)).toEqual({ type: "text", text: heading + renderRetrievalEvidence(always), cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(blocks.at(-1)).toEqual({ type: "text", text: renderRetrievalEvidence(retrieved) });
  });

  it("the cached blocks are byte-identical for two different retrieved sets", () => {
    const first = buildWideSystemPrompt(corpus, always, retrieved);
    const second = buildWideSystemPrompt(corpus, always, [unit("FICTION-TWO", "Built a fictional lens."), ...retrieved]);
    expect(Buffer.from(JSON.stringify(first.slice(0, -1)))).toEqual(Buffer.from(JSON.stringify(second.slice(0, -1))));
    expect(first.at(-1)!.text).not.toBe(second.at(-1)!.text);
  });

  it("never contains whole-corpus document blocks", () => {
    for (const block of buildWideSystemPrompt(corpus, always, retrieved)) {
      expect(block.text).not.toContain("WHOLE-CORPUS-ONLY-CANARY");
      for (const tag of block.text.match(/<document\b[^>]*>/g) ?? []) {
        expect(tag).toMatch(/\bid="/);
      }
      expect(block.text).not.toMatch(/<document title=(?![^>]*\bid=)/);
    }
  });

  it("preserves instruction-bearing about units in the always block", () => {
    const block = buildWideSystemPrompt(corpus, always, retrieved).at(-2)!;
    expect(block.text).toContain(always[0].promptText);
    expect(always[0].searchText).not.toContain("Answerer instructions");
  });

  it("omits the retrieved block when nothing was retrieved", () => {
    const blocks = buildWideSystemPrompt(corpus, always, []);
    expect(blocks).toHaveLength(buildSharedPromptPrefix(corpus).length + 1);
    expect(blocks.at(-1)).toEqual({ type: "text", text: heading + renderRetrievalEvidence(always), cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(blocks.filter(block => block.cache_control !== undefined)).toHaveLength(1);
  });

  it("keeps a cached heading-only always block when always is empty", () => {
    for (const selected of [retrieved, []]) {
      const blocks = buildWideSystemPrompt(corpus, [], selected);
      expect(blocks[buildSharedPromptPrefix(corpus).length]).toEqual({ type: "text", text: heading, cache_control: { type: "ephemeral", ttl: "1h" } });
      expect(blocks.filter(block => block.cache_control !== undefined)).toHaveLength(1);
      expect(blocks).toHaveLength(buildSharedPromptPrefix(corpus).length + 1 + (selected.length ? 1 : 0));
    }
  });
});
