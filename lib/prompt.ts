import type Anthropic from "@anthropic-ai/sdk";
import type { Corpus } from "./corpus";
import { answerRules } from "./answer-rules";

// Deterministic escaping so the cached block is byte-stable and document text
// cannot close its own tag early.
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escBody = (s: string) => s.replace(/<\/(\s*document)/gi, "<\\/$1");

export function buildSystemPrompt(corpus: Corpus): Anthropic.Beta.BetaTextBlockParam[] {
  const docs = corpus.documents
    .map((d) => `<document title="${escAttr(d.title)}">\n${escBody(d.text)}\n</document>`)
    .join("\n\n");
  return [
    { type: "text", text: answerRules(corpus.profile.name) },
    { type: "text", text: `# Positioning notes\n\n${corpus.positioningNotes}` },
    { type: "text", text: docs, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
}
