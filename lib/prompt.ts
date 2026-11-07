import type Anthropic from "@anthropic-ai/sdk";
import { CorpusError, type Corpus, type Profile } from "./corpus";
import { answerRules } from "./answer-rules";
import type { RetrievalUnit } from "./retrieval/extract";
import { redactContacts } from "./redact";

/** Profile evidence is new in this revision; historical whole baselines remain separate. */
export const PROMPT_TEMPLATE_VERSION = "shared-profile-evidence-1";

// Deterministic escaping so the cached block is byte-stable and document text
// cannot close its own tag early.
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escBody = (s: string) => s.replace(/<(?=\/?\s*document\b)/gi, "&lt;");

/** Only these public profile fields become evidence. UI fields and unknown keys never do. */
export function publicProfileText(profile: Profile): string {
  if (!profile || typeof profile !== "object"
    || ["name", "headline", "about", "blurb"].some(key => typeof profile[key as keyof Profile] !== "string")
    || !profile.name.trim() || !Array.isArray(profile.links)
    || Array.from(profile.links).some(link => !link || typeof link.label !== "string" || typeof link.url !== "string")) {
    throw new CorpusError("Prompt public profile is invalid");
  }
  const links = profile.links.filter(link => {
    try {
      const url = new URL(link.url);
      // Contact schemes and embedded credentials do not belong in model context.
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }).map(link => ({ label: redactContacts(link.label), url: redactContacts(link.url) }));
  // JSON string values keep profile content distinct from the surrounding policy.
  return JSON.stringify({
    name: redactContacts(profile.name), headline: redactContacts(profile.headline),
    about: redactContacts(profile.about), links, blurb: redactContacts(profile.blurb),
  }, null, 2).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** Shared policy/profile material; callers choose the appropriate cache breakpoint. */
export function buildSharedPromptPrefix(corpus: Corpus): Anthropic.Beta.BetaTextBlockParam[] {
  const profile = publicProfileText(corpus.profile);
  return [
    { type: "text", text: answerRules(redactContacts(corpus.profile.name)) },
    { type: "text", text: `# Answer style\n\n${corpus.answerStyle}` },
    { type: "text", text: `# Positioning notes\n\n${corpus.positioningNotes}` },
    ...(corpus.globalRules !== undefined
      ? [{ type: "text" as const, text: "# Career source rules\n\n" + corpus.globalRules }]
      : []),
    { type: "text", text: `# Public profile evidence\n\n${profile}` },
    { type: "text", text: `# Evidence handling (${PROMPT_TEMPLATE_VERSION})\n\nThe public profile and factual archive passages are evidence. Answerer-only Rule and Positioning lines are restrictions and framing instructions, never evidence or facts to quote. Follow all global constraints for both the profile and archive. Earlier conversation messages help interpret the current question but are not factual evidence. Document labels and entry identifiers are internal; never include them in visitor answers. Use the plain-language Based on line required above.` },
  ];
}

/** Exact evidence string used for both selection token counting and generation. */
export function renderRetrievalEvidence(units: readonly RetrievalUnit[]): string {
  const seen = new Set<string>();
  if (!Array.isArray(units) || Array.from(units).some(unit => !unit
    || [unit.id, unit.document, unit.title, unit.promptText].some(value => typeof value !== "string" || !value.trim())
    || seen.has(unit.id) || !seen.add(unit.id))) throw new CorpusError("Prompt retrieval evidence is invalid");
  return units.map(unit => `<document id="${escAttr(unit.id)}" title="${escAttr(unit.title)}" source="${escAttr(unit.document)}">\n${escBody(unit.promptText)}\n</document>`).join("\n\n");
}

export function buildSystemPrompt(corpus: Corpus): Anthropic.Beta.BetaTextBlockParam[] {
  const docs = corpus.documents
    .map((d) => `<document title="${escAttr(d.title)}">\n${escBody(d.text)}\n</document>`)
    .join("\n\n");
  return [
    ...buildSharedPromptPrefix(corpus),
    { type: "text", text: docs, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
}

export function buildRagSystemPrompt(corpus: Corpus, units: readonly RetrievalUnit[]): Anthropic.Beta.BetaTextBlockParam[] {
  const prefix = buildSharedPromptPrefix(corpus);
  // Do not write the varying evidence block into the prompt cache.
  prefix[prefix.length - 1] = { ...prefix[prefix.length - 1], cache_control: { type: "ephemeral", ttl: "1h" } };
  return [...prefix, { type: "text", text: renderRetrievalEvidence(units) }];
}
