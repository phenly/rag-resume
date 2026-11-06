import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Corpus } from '../corpus';
import { buildSystemPrompt } from '../prompt';
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
  return { ids, text: '# Source facts\n' + metadata + corpus.documents.map(d => `# ${d.title}\n${d.text}`).join('\n\n') + `\n\n# Positioning notes and handling rules\n${corpus.positioningNotes}` + (corpus.globalRules ? `\n\n# Source rules\n${corpus.globalRules}` : '') + `\n\n# Answer style and response behavior (guidance, not career facts)\n${corpus.answerStyle}` };
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
  const groups = {
    careerChunks: [system[system.length - 1]], answerStyle: [system[1]], positioningNotes: [system[2]],
    globalRules: corpus.globalRules !== undefined ? [system[3]] : [],
    generatedAnswerRules: [system[0]],
    profile: [{ type: 'text' as const, text: JSON.stringify(corpus.profile) }],
  };
  const total = await count(system);
  for (const [name, blocks] of Object.entries(groups)) parts[name] = await count(blocks);
  return { model, total, parts, note: 'Exact API count of buildSystemPrompt, no visitor question. Parts counted independently; full profile is supplemental and is not included in the live prompt (only its name appears in generated rules).' };
}
