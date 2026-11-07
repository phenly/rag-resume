import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Corpus } from '../corpus';
import { buildSharedPromptPrefix, buildSystemPrompt, publicProfileText, PROMPT_TEMPLATE_VERSION } from '../prompt';
import { retry } from './retry';

/** Use export IDs, never invent RAG IDs from filenames. Sample corpus has atom IDs. */
export async function chunkIndex(dir: string, corpus: Corpus): Promise<{ ids: string[]; text: string }> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'corpus.json'), 'utf8'));
  let ids: string[];
  let metadata = '';
  if (manifest.documentsFrom) {
    const exported = JSON.parse(await readFile(path.resolve(dir, manifest.documentsFrom), 'utf8'));
    if (!exported.chunks || typeof exported.chunks !== 'object') throw new Error('Eval needs bot-export.json chunks metadata for reliable chunk IDs');
    const entries: [string, { title?: string }][] = Array.isArray(exported.chunks)
      ? exported.chunks.map((c: { id: string; title?: string }) => [c.id, c])
      : Object.entries(exported.chunks);
    if (entries.some(([id, c]) => typeof id !== 'string' || !id || !c || typeof c.title !== 'string')) throw new Error('Invalid bot-export.json chunk ID/title metadata');
    ids = entries.map(([id]) => id);
    metadata = `Chunk index (IDs and source titles):\n${entries.map(([id, c]) => `${id}: ${c.title}`).join('\n')}\n\n`;
  } else {
    ids = [...new Set(corpus.documents.flatMap(d => [...d.text.matchAll(/\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]/g)].map(m => m[1])))];
  }
  return { ids, text: '# Source facts\n# Public profile evidence\n' + publicProfileText(corpus.profile) + '\n\n' + metadata + corpus.documents.map(d => `# ${d.title}\n${d.text}`).join('\n\n') + `\n\n# Positioning notes and handling rules\n${corpus.positioningNotes}` + (corpus.globalRules ? `\n\n# Source rules\n${corpus.globalRules}` : '') + `\n\n# Answer style and response behavior (guidance, not career facts)\n${corpus.answerStyle}` };
}
export async function countCorpus(client: Anthropic, model: string, corpus: Corpus) {
  const system = buildSystemPrompt(corpus);
  // The API requires one message; count a one-character probe once and subtract it.
  const probe = [{ role: 'user' as const, content: '.' }];
  const raw = async (blocks: typeof system) =>
    (await retry(() => client.beta.messages.countTokens({ model, ...(blocks.length ? { system: blocks } : {}), messages: probe }))).input_tokens;
  const baseline = await raw([]);
  const count = async (blocks: typeof system) => {
    if (!blocks.length || blocks.every(b => !b.text)) return 0;
    return (await raw(blocks)) - baseline;
  };
  // Independent counts include tokenizer/API framing; parts need not sum to the exact combined total.
  const parts: Record<string, number> = {};
  const prefix = buildSharedPromptPrefix(corpus);
  const section = (heading: string) => prefix.filter(block => block.text.startsWith(heading + '\n'));
  const groups = {
    careerChunks: [system[system.length - 1]], answerStyle: [system[1]], positioningNotes: [system[2]],
    globalRules: section('# Career source rules'),
    generatedAnswerRules: [system[0]],
    profile: section('# Public profile evidence'),
    evidenceHandling: section('# Evidence handling (' + PROMPT_TEMPLATE_VERSION + ')'),
  };
  const total = await count(system);
  for (const [name, blocks] of Object.entries(groups)) parts[name] = await count(blocks);
  return { model, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, total, parts, note: 'API token count of the exact buildSystemPrompt request with the fixed probe subtracted, no visitor question. Parts are counted independently and need not sum to the total. The allowlisted, redacted public profile is now included in both approaches; older prompt receipts are historical baselines.' };
}
