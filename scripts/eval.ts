import Anthropic from '@anthropic-ai/sdk';
import { readAskConfig } from '../lib/claude';
import { loadCorpus, resolveCorpusDir } from '../lib/corpus';
import { readCases } from '../lib/eval/cases';
import { chunkIndex, countCorpus } from '../lib/eval/corpus';
import { createJudge } from '../lib/eval/judge';
import { runApproach } from '../lib/eval/runner';
import { writeRun, type Run } from '../lib/eval/report';
import { wholeApproach } from '../lib/eval/whole';
import { PROMPT_TEMPLATE_VERSION } from '../lib/prompt';

const help = `Usage: npm run eval -- --cases <path> --out <dir> [options]
  --approach whole|rag|both  Default: whole; rag is not built
  --only id,id              Run selected case IDs
  --concurrency N           After the first question; default 3 (first is serial)
  --no-judge                Run checks only; no quality pass rate
  --help                   Show help offline, without loading corpus or API config
Uses CORPUS_DIR, ANTHROPIC_API_KEY, RAG_MODEL / RAG_EFFORT / RAG_MAX_TOKENS,
and EVAL_JUDGE_MODEL (default claude-sonnet-5-5). Output contains private answers.`;
async function main(args: string[]) {
  if (args.includes('--help')) { console.log(help); return; }
  const options: Record<string, string> = {};
  let noJudge = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--no-judge') { noJudge = true; continue; }
    if (!['--cases', '--out', '--approach', '--only', '--concurrency'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${key}\n${help}`);
    options[key] = args[++i];
  }
  if (!options['--cases'] || !options['--out']) throw new Error(help);
  const selected = options['--approach'] ?? 'whole';
  if (!['whole', 'rag', 'both'].includes(selected)) throw new Error('--approach must be whole, rag, or both');
  const concurrency = Number(options['--concurrency'] ?? 3);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  let { cases } = await readCases(options['--cases']);
  if (options['--only']) {
    const ids = options['--only'].split(',');
    for (const id of ids) if (!cases.some(c => c.id === id)) throw new Error(`Unknown case ID: ${id}`);
    cases = cases.filter(c => ids.includes(c.id));
  }
  const startedAt = new Date().toISOString();
  const dir = resolveCorpusDir();
  const corpus = await loadCorpus(dir);
  const index = await chunkIndex(dir, corpus);
  if (selected !== 'rag') {
    for (const c of cases) for (const id of c.goldChunkSets?.flat() ?? c.goldChunks) if (!index.ids.includes(id)) throw new Error(`${c.id}: gold chunk ${id} is absent from corpus chunk index`);
  }
  const run: Run = { version: 1, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, startedAt, answerModel: process.env.RAG_MODEL?.trim() || 'claude-opus-5-5', judgeModel: noJudge ? null : process.env.EVAL_JUDGE_MODEL?.trim() || 'claude-sonnet-5-5', corpus: { version: corpus.version, chunkCount: index.ids.length }, approaches: [] };
  if (selected !== 'rag') {
    const config = readAskConfig();
    const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
    try { run.corpus.tokens = await countCorpus(client, config.model, corpus); }
    catch (e) { run.corpus.tokenError = String(e); }
    run.approaches.push(await runApproach({ approach: wholeApproach(config, client), corpus, cases, concurrency, model: config.model, judgeModel: run.judgeModel ?? '', judge: noJudge ? undefined : createJudge(client, run.judgeModel!, index.text) }));
  }
  if (selected !== 'whole') {
    console.log('rag: not built; skipping questions for this approach.');
    run.approaches.push(await runApproach({ corpus, cases, concurrency, model: run.answerModel, judgeModel: run.judgeModel ?? '' }));
  }
  console.log(`Results: ${await writeRun(options['--out'], run)}`);
}
main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
