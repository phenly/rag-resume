import { pathToFileURL } from 'node:url';
import { assertNever } from '../lib/retrieval/assert-never';
import type { RagResolution } from '../lib/retrieval/pipeline';
import type { Corpus } from '../lib/corpus';
import type { EvalCase } from '../lib/eval/types';
/** Bounded local provider check. Output is private; never deploys or changes approach. */
import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';
import { readAskConfig } from '../lib/claude';
import { loadCorpus, resolveCorpusDir } from '../lib/corpus';
import { readCases } from '../lib/eval/cases';
import { buildRagSystemPrompt, buildSharedPromptPrefix, buildSystemPrompt } from '../lib/prompt';
import { prepareProductionRagPipeline, createWholeFallbackGuard } from '../lib/retrieval/production';
import { createGenerationTokenBudget } from '../lib/retrieval/token-budget';

/** Resolve one receipt row; guard construction is deferred until generation is eligible for counting. */
export async function preflightResolution(c: Pick<EvalCase, 'id' | 'question' | 'history'>, result: RagResolution,
  corpus: Corpus, createGuard: () => ReturnType<typeof createWholeFallbackGuard>) {
  const row = { id: c.id, kind: result.kind, trace: result.trace };
  let system: ReturnType<typeof buildSystemPrompt>;
  switch (result.kind) {
    case 'unavailable':
    case 'route':
    case 'cancelled': return { ...row, eligibility: null, countMs: null };
    case 'evidence': system = buildRagSystemPrompt(corpus, result.selected); break;
    case 'fallback': system = buildSystemPrompt(corpus); break;
    default: assertNever(result);
  }
  const guard = createGuard();
  const countStart = performance.now();
  const eligibility = await guard({ question: c.question, system,
    history: c.history?.map(turn => ({ ...turn, sig: 'trusted-offline-fixture' })) });
  return { ...row, eligibility, countMs: performance.now() - countStart };
}

async function main() {
  const [casesFile, ids, output, ...extra] = process.argv.slice(2);
  if (!casesFile || !ids || !output || extra.length) throw new Error('Usage: rag-preflight.ts <cases.json> <id,id> <private-output.json>');
  const requested = ids.split(',');
  if (requested.length > 5 || new Set(requested).size !== requested.length) throw new Error('Select at most five unique cases');
  const { cases } = await readCases(casesFile);
  const selected = requested.map(id => {
    const found = cases.find(c => c.id === id);
    if (!found) throw new Error('Unknown case');
    return found;
  });
  // Reserve the receipt before spending credits; never overwrite an earlier run.
  await writeFile(output, JSON.stringify({ status: 'started', startedAt: new Date().toISOString(), caseIds: requested }) + '\n', { flag: 'wx', mode: 0o600 });
  const corpusDir = resolveCorpusDir();
  const corpus = await loadCorpus(corpusDir);
  const config = readAskConfig();
  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: 10_000 });
  const started = performance.now();
  const pipeline = await prepareProductionRagPipeline({ corpus, corpusDir, config, client });
  const prepareMs = performance.now() - started;
  const counter = createGenerationTokenBudget({ model: config.model, countTokens: client.beta.messages.countTokens.bind(client.beta.messages) });
  const prefixTokens = await counter.countRequest({ system: buildSharedPromptPrefix(corpus), question: '.' }, { signal: AbortSignal.timeout(5000) });
  const rows = [];
  for (const c of selected) {
    const result = await pipeline.resolve({ question: c.question, verifiedHistory: c.history });
    rows.push(await preflightResolution(c, result, corpus, () => createWholeFallbackGuard({ corpus, corpusDir, config, client })));
  }
  await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), corpusVersion: corpus.version,
    ready: pipeline.ready, prepareMs, prefixTokensIncludingProbe: prefixTokens, model: config.model, rows }, null, 2) + '\n');
  console.log(JSON.stringify({ ready: pipeline.ready, prepareMs, prefixTokensIncludingProbe: prefixTokens,
    outcomes: rows.map(row => ({ id: row.id, kind: row.kind, reason: row.trace.fallbackReason, countMs: row.countMs, eligibility: row.eligibility })) }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('RAG preflight failed; inspect local configuration and connectivity.'); process.exitCode = 1; });
