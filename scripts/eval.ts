import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAskConfig } from '../lib/claude';
import { loadCorpus, resolveCorpusDir } from '../lib/corpus';
import { readCases } from '../lib/eval/cases';
import { chunkIndex, countCorpus } from '../lib/eval/corpus';
import { createJudge } from '../lib/eval/judge';
import { runApproach } from '../lib/eval/runner';
import { writeRun, type Run } from '../lib/eval/report';
import { withEvalSnapshot } from '../lib/eval/snapshot';
import { ragApproach } from '../lib/eval/rag';
import { wholeApproach } from '../lib/eval/whole';
import { RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';
import { PROMPT_TEMPLATE_VERSION } from '../lib/prompt';
import { MODEL_PRICES } from '../lib/eval/pricing';
import { JEV_INPUT_USD_PER_MILLION } from '../lib/retrieval/jev';
import { RETRIEVAL_PIPELINE_CONFIG } from '../lib/retrieval/pipeline';
import { isAccountQuotaError } from '../lib/eval/retry';

const help = `Usage: npm run eval -- --cases <path> --out <dir> [options]
  --approach whole|rag|both  Default: whole; rag requires retrieval provider keys and a context limit
  --only id,id              Run selected case IDs
  --concurrency N           After the first question; default 3 (first is serial)
  --no-judge                Run checks only; no quality pass rate
  --help                   Show help offline, without loading corpus or API config
Uses CORPUS_DIR, ANTHROPIC_API_KEY, RAG_MODEL / RAG_EFFORT / RAG_MAX_TOKENS,
and EVAL_JUDGE_MODEL (default claude-sonnet-5-5). Output contains private answers.`;
export async function main(args: string[]) {
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
  const sourceDir = resolveCorpusDir();
  const evaluate = async (dir: string) => {
    const corpus = await loadCorpus(dir);
    const indexSnapshot = selected === 'whole' ? undefined : await readFile(path.join(dir, 'retrieval-index.json'), 'utf8');
    const configReceipt = readAskConfig();
    const receipt = {
      codeRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      workingTreeDirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      workingDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { maxBuffer: 16 * 1024 * 1024 })).digest('hex'),
      caseSetSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
      retrievalIndexSha256: indexSnapshot ? createHash('sha256').update(indexSnapshot).digest('hex') : null,
      generator: { model: configReceipt.model, effort: configReceipt.effort, maxTokens: configReceipt.maxTokens,
        contextTokens: process.env.RAG_GENERATOR_CONTEXT_TOKENS ?? null },
      gradingVersion: 'context-grounding-stage-recall-quota-2',
    };
    const index = await chunkIndex(dir, corpus);
    for (const c of cases) for (const id of c.goldChunkSets?.flat() ?? c.goldChunks) if (!index.ids.includes(id)) throw new Error(`${c.id}: gold chunk ${id} is absent from corpus chunk index`);
    const run: Run = { version: 1, status: 'complete', retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, promptTemplateVersion: PROMPT_TEMPLATE_VERSION, startedAt, answerModel: configReceipt.model, judgeModel: noJudge ? null : process.env.EVAL_JUDGE_MODEL?.trim() || 'claude-sonnet-5-5', corpus: { version: corpus.version, chunkCount: index.ids.length }, approaches: [] };
    const frozenFiles: Record<string, string> = {
      'receipt.json': JSON.stringify(receipt, null, 2) + '\n',
      'cases.json': JSON.stringify({ version: 1, cases }, null, 2) + '\n',
      'corpus-snapshot.json': JSON.stringify(corpus, null, 2) + '\n',
      'pricing.json': JSON.stringify({ generatorAndJudge: MODEL_PRICES,
        jevInputUsdPerMillion: JEV_INPUT_USD_PER_MILLION,
        voyageInputUsdPerMillion: RETRIEVAL_PIPELINE_CONFIG.embeddingUsdPerMillionTokens }, null, 2) + '\n',
      ...(indexSnapshot ? { 'retrieval-index.json': indexSnapshot } : {}),
    };
    // A killed process leaves a recoverable ignored snapshot and these frozen inputs.
    if (selected !== 'whole') for (const [name, text] of Object.entries(frozenFiles)) {
      await writeFile(path.join(path.dirname(dir), name), text, { mode: 0o600 });
    }
    try {
      if (selected !== 'rag') {
        const config = configReceipt;
        const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
        try { run.corpus.tokens = await countCorpus(client, config.model, corpus); }
        catch (e) {
          run.corpus.tokenError = String(e);
          if (isAccountQuotaError(e)) {
            run.stopReason = 'account-quota during corpus token counting; no answer approaches were started.';
            throw e;
          }
        }
        run.approaches.push(await runApproach({ approach: wholeApproach(config, client), corpus, cases, concurrency, model: config.model, judgeModel: run.judgeModel ?? '', judge: noJudge ? undefined : createJudge(client, run.judgeModel!, index.text) }));
      }
      if (selected !== 'whole' && !run.approaches.some(approach => approach.status === 'incomplete')) {
        const config = configReceipt;
        const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 });
        run.approaches.push(await runApproach({ approach: ragApproach(config, { corpusDir: dir, client }), corpus, cases, concurrency, model: config.model, judgeModel: run.judgeModel ?? '', judge: noJudge ? undefined : createJudge(client, run.judgeModel!, index.text) }));
      }
      const stopped = run.approaches.find(approach => approach.status === 'incomplete');
      if (stopped) {
        run.status = 'incomplete';
        run.stopReason = `${stopped.name}: ${stopped.incompleteReason ?? 'stopped early'}; queued approaches were not started.`;
        throw new Error('Evaluation incomplete; partial results and receipts were preserved.');
      }
    } catch (error) {
      run.status = 'incomplete';
      run.stopReason ??= 'Evaluation failed before all requested approaches completed.';
      frozenFiles['run-error.json'] = JSON.stringify({ error: String(error), failedAt: new Date().toISOString() }, null, 2) + '\n';
      throw error;
    } finally {
      frozenFiles['completion.json'] = JSON.stringify({ status: run.status, stopReason: run.stopReason,
        approachesSkipped: (selected === 'both' ? ['whole', 'rag'] : [selected]).filter(name => !run.approaches.some(approach => approach.name === name)) }, null, 2) + '\n';
      const destination = await writeRun(options['--out'], run);
      for (const [name, text] of Object.entries(frozenFiles)) await writeFile(path.join(destination, name), text, { mode: 0o600 });
      if (selected !== 'whole') await cp(dir, path.join(destination, 'corpus'), { recursive: true, force: false, errorOnExist: true });
      console.log(`Results: ${destination}`);
    }
  };
  if (selected === 'whole') await evaluate(sourceDir);
  else await withEvalSnapshot(sourceDir, evaluate);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
