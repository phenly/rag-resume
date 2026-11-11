import { realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadCorpus, resolveCorpusDir } from '../lib/corpus';
import { readCases } from '../lib/eval/cases';
import { coverageRows, coverageSummary } from '../lib/eval/coverage';
import { configuredStrategy } from '../lib/retrieval/load';
import type { RagPipeline } from '../lib/retrieval/pipeline';
import { prepareWidePipeline, WIDE_CONFIG_VERSION } from '../lib/retrieval/pipeline-wide';
import { createRetrievalTokenBudgets } from '../lib/retrieval/token-budget';
import { createVoyageEmbedder } from '../lib/retrieval/voyage';
import { createVoyageQueryTokenCounter } from '../lib/retrieval/voyage-tokenizer';

async function preparePipeline(env: Record<string, string | undefined>): Promise<RagPipeline> {
  const corpusDir = resolveCorpusDir();
  const corpus = await loadCorpus(corpusDir);
  const voyage = await createVoyageQueryTokenCounter();
  return prepareWidePipeline({ corpus, corpusDir,
    embedder: createVoyageEmbedder({ apiKey: env.VOYAGE_API_KEY ?? '', timeoutMs: 2000 }),
    countQueryTokens: createRetrievalTokenBudgets({ voyage }).query,
  });
}

/** Injection keeps CLI checks offline; production has only a query embedder. */
export async function runCoverageCli(args: string[], env: Record<string, string | undefined>,
  prepare: () => Promise<RagPipeline> = () => preparePipeline(env)) {
  const [casesFile, output, ...extra] = args;
  if (!casesFile || !output || extra.length) throw new Error('Usage: retrieval-coverage.ts <cases.json> <new-output.json>');
  if (configuredStrategy(env) !== 'wide') throw new Error('Retrieval coverage requires CVAI_RETRIEVAL_STRATEGY=wide');
  const { cases } = await readCases(casesFile);
  // Reserve privately and exclusively before any embedding expense. Keep this
  // handle for the final write so an existing receipt is never reopened.
  const file = await open(output, 'wx', 0o600);
  try {
    const pipeline = await prepare();
    const rows = await coverageRows({ cases, pipeline });
    const summary = coverageSummary(rows);
    await file.writeFile(JSON.stringify({ measuredAt: new Date().toISOString(), retrievalConfigVersion: WIDE_CONFIG_VERSION,
      ready: pipeline.ready, summary, rows }, null, 2) + '\n');
    console.log(JSON.stringify(summary, null, 2));
    for (const row of rows.filter(row => row.hasGold && row.fullGoldSupplied !== true))
      console.log(JSON.stringify({ id: row.id, resolution: row.resolution, missing: row.missing, fullGoldWithLexical24: row.fullGoldWithLexical24 }));
  } finally {
    await file.close();
  }
}

function isMainModule(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMainModule()) runCoverageCli(process.argv.slice(2), process.env).catch(error => {
  console.error(error instanceof Error ? error.message : 'Retrieval coverage failed');
  process.exitCode = 1;
});
