import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { categories, type ApproachResult, type CaseResult } from './types';
import type { countCorpus } from './corpus';
export type Run = {
  version: 1; promptTemplateVersion?: string; retrievalConfigVersion?: string; startedAt: string; answerModel: string; judgeModel: string | null;
  corpus: { version: string; chunkCount: number; tokens?: Awaited<ReturnType<typeof countCorpus>>; tokenError?: string };
  approaches: ApproachResult[];
};
const eligible = (r: CaseResult) => r.case.status !== 'open' && r.case.category !== 'leak-probe';
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
/** Nearest-rank percentiles; empty or unavailable timings remain unmeasured. */
function latency(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.ceil(fraction * sorted.length) - 1] : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}
export function summarize(a: ApproachResult) {
  const scored = a.cases.filter(eligible);
  const passing = scored.filter(r => r.status === 'pass').length;
  const judged = scored.filter(r => !['unjudged'].includes(r.status));
  const sumCost = (key: 'answerDollars' | 'judgeDollars', rows = a.cases) =>
    rows.some(r => r[key] == null || (key === 'answerDollars' ? r.answerCostIncomplete : r.judgeCostIncomplete)) ? null : rows.reduce((s, r) => s + r[key]!, 0);
  const answerDollars = sumCost('answerDollars');
  const judgeDollars = sumCost('judgeDollars');
  const retrievalDollars = a.cases.some(r => r.retrievalCostIncomplete || r.retrievalDollars === null) ? null : a.cases.reduce((s, r) => s + (r.retrievalKnownDollars ?? r.retrievalDollars ?? 0), 0);
  const eligibleAnswerDollars = sumCost('answerDollars', scored);
  const eligibleJudgeDollars = sumCost('judgeDollars', scored);
  const usage = a.cases.flatMap(r => r.answer ? [r.answer.usage] : r.answerUsage ? [r.answerUsage] : []);
  const input = usage.reduce((s, u) => s + u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), 0);
  const speeds = Object.fromEntries(['cold', 'warm', 'uncached'].map(kind => {
    const answers = a.cases.flatMap(r => r.answer ? [r.answer] : []).filter(a =>
      kind === 'cold' ? (a.usage.cache_creation_input_tokens ?? 0) > 0 : kind === 'warm' ? !(a.usage.cache_creation_input_tokens ?? 0) && (a.usage.cache_read_input_tokens ?? 0) > 0 : !(a.usage.cache_creation_input_tokens ?? 0) && !(a.usage.cache_read_input_tokens ?? 0));
    return [kind, { count: answers.length, firstTokenMs: mean(answers.flatMap(a => a.timings.firstTokenMs === null ? [] : [a.timings.firstTokenMs])), totalMs: mean(answers.map(a => a.timings.totalMs)) }];
  }));
  const comparisonIneligible = a.cases.filter(r => r.answer && r.answer.effectiveApproach !== 'deterministic' && r.comparisonEligible !== true).map(r => r.case.id);
  const fallbackCount = a.name === 'rag' ? a.cases.filter(r => (r.answer?.retrievalTrace ?? r.retrievalTrace)?.fallbackReason !== undefined).length : 0;
  return {
    comparisonValid: comparisonIneligible.length === 0,
    comparisonInvalidReason: comparisonIneligible.length ? 'Generated answer model receipts are missing, mixed or substituted; descriptive pass rates retain every eligible case.' : null,
    latencyByEffectiveApproach: Object.fromEntries(['rag', 'whole', 'deterministic'].map(kind => {
      const answers = a.cases.flatMap(r => r.answer?.effectiveApproach === kind ? [r.answer] : []);
      return [kind, { answers: answers.length,
        firstTokenMs: latency(answers.flatMap(answer => answer.timings.firstTokenMs === null ? [] : [answer.timings.firstTokenMs])),
        totalMs: latency(answers.map(answer => answer.timings.totalMs)) }];
    })),
    fallback: { count: fallbackCount, attempted: a.name === 'rag' ? a.cases.length : 0, frequency: a.name === 'rag' && a.cases.length ? fallbackCount / a.cases.length : null,
      completedWholeAnswers: a.name === 'rag' ? a.cases.filter(r => r.answer?.effectiveApproach === 'whole').length : 0 },
    contextGrounding: { assessed: a.cases.filter(r => r.judge?.contextGrounding === 'assessed').length,
      unavailable: a.cases.filter(r => r.judge && r.judge.contextGrounding !== 'assessed').length,
      unjudged: a.cases.filter(r => !r.judge).length },
    eligible: scored.length, passing, passRate: scored.length && judged.length === scored.length ? passing / scored.length : null,
    categories: Object.fromEntries(categories.map(category => {
      const rows = scored.filter(r => r.case.category === category);
      return [category, { eligible: rows.length, passing: rows.filter(r => r.status === 'pass').length,
        passRate: rows.length && rows.every(r => r.status !== 'unjudged') ? rows.filter(r => r.status === 'pass').length / rows.length : null }];
    })),
    comparisonIneligible,
    contextGroundingUnavailable: a.cases.filter(r => r.judge && r.judge.contextGrounding !== 'assessed').map(r => r.case.id),
    retrievalStages: Object.fromEntries(['dense', 'lexical', 'fused', 'filtered', 'reranked', 'selected'].map(stage => {
      const metrics = a.cases.flatMap(r => { const value = r.retrievalStages?.[stage as keyof NonNullable<CaseResult['retrievalStages']>]; return value?.recallAtK == null ? [] : [value.recallAtK]; });
      return [stage, { cases: metrics.length, meanRecall: mean(metrics) }];
    })),
    effectiveApproaches: Object.fromEntries(['rag', 'whole', 'deterministic'].map(kind => [kind, { answers: a.cases.filter(r => r.answer?.effectiveApproach === kind).length, passing: scored.filter(r => r.answer?.effectiveApproach === kind && r.status === 'pass').length }])),
    leakFailures: a.cases.filter(r => r.status === 'leak-failure').map(r => r.case.id),
    answerDollars, judgeDollars, retrievalDollars, totalDollars: answerDollars === null || judgeDollars === null || retrievalDollars === null ? null : answerDollars + judgeDollars + retrievalDollars,
    costIncomplete: answerDollars === null || judgeDollars === null || retrievalDollars === null,
    knownDollars: a.cases.reduce((s, r) => s + (r.answerDollars ?? 0) + (r.judgeDollars ?? 0) + (r.retrievalKnownDollars ?? r.retrievalDollars ?? 0), 0),
    dollarsPerPassingAnswer: passing && eligibleAnswerDollars !== null && eligibleJudgeDollars !== null && retrievalDollars !== null ? (eligibleAnswerDollars + eligibleJudgeDollars + scored.reduce((s, r) => s + (r.retrievalKnownDollars ?? r.retrievalDollars ?? 0), 0)) / passing : null,
    cacheHitRate: a.name === 'whole' && input ? usage.reduce((s, u) => s + (u.cache_read_input_tokens ?? 0), 0) / input : null,
    speeds,
  };
}
const cell = (v: unknown) => String(v ?? 'n.a.').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const pct = (n: number | null) => n === null ? 'n.a.' : `${(n * 100).toFixed(1)}%`;
export function report(run: Run): string {
  const t = run.corpus.tokens?.total;
  const pressure = t === undefined ? 'unavailable' : t < 50000 ? '<50k: fine' : t < 100000 ? '50–100k: monitor' : t <= 200000 ? '100–200k: strains' : t < 500000 ? '200–500k: beyond strain range' : '500k+: RAG required';
  const lines = [`# CV-AI evaluation — ${run.startedAt}`, '', `Corpus: ${run.corpus.version}; chunks: ${run.corpus.chunkCount}.`,
    `Answer model: ${run.answerModel}; judge: ${run.judgeModel ?? 'disabled'}.`,
    `Prompt template: ${run.promptTemplateVersion ?? run.corpus.tokens?.promptTemplateVersion ?? 'historical/unrecorded'}.`,
    `Retrieval configuration: ${run.retrievalConfigVersion ?? 'historical/unrecorded'}.`, '',
    `Exact prompt tokens: ${t ?? 'unavailable'} — ${pressure}.`, run.corpus.tokens?.note ?? (run.corpus.tokenError ? `Token counting error: ${run.corpus.tokenError}` : 'Token counting skipped: no built approach selected.'), '',
    '| Corpus part | API tokens |', '| --- | ---: |', ...Object.entries(run.corpus.tokens?.parts ?? {}).map(([k, v]) => `| ${k} | ${v} |`), ''];
  for (const a of run.approaches) {
    lines.push(`## ${a.name} — ${a.status}`, '');
    if (a.status === 'not built') { lines.push('This approach is not built; no questions were sent.', ''); continue; }
    const s = summarize(a);
    lines.push(`Comparative model eligibility: **${s.comparisonValid ? 'VALID' : 'INVALID'}**. ${s.comparisonInvalidReason ?? 'All generated answer model receipts match the configured model.'}`, '', `Pass rate: **${pct(s.passRate)}** (${s.passing}/${s.eligible}; excludes open cases and all leak probes). Unjudged runs have no pass rate.`, '',
      '| Category | Pass / eligible | Rate |', '| --- | ---: | ---: |',
      ...Object.entries(s.categories).map(([k, v]) => `| ${k} | ${v.passing}/${v.eligible} | ${pct(v.passRate)} |`), '',
      `Comparison-ineligible model receipts (missing, mixed or substituted): ${s.comparisonIneligible.join(', ') || 'none'}.`,
      `Actual-context grounding: ${s.contextGrounding.assessed} assessed, ${s.contextGrounding.unavailable} unavailable, ${s.contextGrounding.unjudged} unjudged.`,
      `Actual-context grounding unavailable: ${s.contextGroundingUnavailable.join(', ') || 'none'}.`, '',
      `Leak failures: ${s.leakFailures.join(', ') || 'none'}.`, '',
      ...(a.name === 'rag' ? [`Effective answer paths (fallback successes are separate): ${JSON.stringify(s.effectiveApproaches)}.`, ''] : []),
      ...(a.name === 'rag' ? [`Fallbacks: ${s.fallback.count}/${s.fallback.attempted} attempted (${pct(s.fallback.frequency)}); ${s.fallback.completedWholeAnswers} completed whole-corpus answers.`, ''] : []),
      '| Effective path | Answers | First-token samples | First-token p50 ms | First-token p95 ms | Total samples | Total p50 ms | Total p95 ms |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...Object.entries(s.latencyByEffectiveApproach).map(([kind, metric]) => `| ${kind} | ${metric.answers} | ${metric.firstTokenMs.count} | ${cell(metric.firstTokenMs.p50)} | ${cell(metric.firstTokenMs.p95)} | ${metric.totalMs.count} | ${cell(metric.totalMs.p50)} | ${cell(metric.totalMs.p95)} |`), '',
      'Percentiles use nearest rank on observed successful-answer samples; missing first-token timings are excluded, never treated as zero. Small sample counts do not establish stable tail latency.', '',
      '| Cost / operation | Value |', '| --- | ---: |',
      ...Object.entries({ answerDollars: s.answerDollars, retrievalDollars: s.retrievalDollars, judgeDollars: s.judgeDollars, totalDollars: s.totalDollars, costIncomplete: s.costIncomplete, knownDollars: s.knownDollars, dollarsPerPassingAnswer: s.dollarsPerPassingAnswer, embeddingDollars: a.embeddingDollars, cacheHitRate: pct(s.cacheHitRate), indexFreshness: a.indexFreshness }).map(([k, v]) => `| ${k} | ${cell(v)} |`), '',
      '| Cache state | Questions | Mean first token ms | Mean total ms |', '| --- | ---: | ---: | ---: |',
      ...Object.entries(s.speeds).map(([k, v]) => `| ${k} | ${v.count} | ${cell(v.firstTokenMs)} | ${cell(v.totalMs)} |`), '',
      ...(s.speeds.cold.count === 0 ? ['No cache-write response was observed; no cold-cache timing was measured.', ''] : []),
      '| Case | Input uncached | Cache write | Cache read | Output | Answer $ | Judge $ |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of a.cases) {
      const u = r.answer?.usage ?? r.answerUsage;
      lines.push(`| ${cell(r.case.id)} | ${cell(u?.input_tokens)} | ${cell(u?.cache_creation_input_tokens ?? (u ? 0 : null))} | ${cell(u?.cache_read_input_tokens ?? (u ? 0 : null))} | ${cell(u?.output_tokens)} | ${cell(r.answerDollars)} | ${cell(r.judgeDollars)} |`);
    }
    lines.push('', '### Failures and review', '');
    for (const r of a.cases.filter(r => r.status !== 'pass' || r.case.status === 'open')) {
      lines.push(`- **${cell(r.case.id)}** (${r.case.status}, ${r.status}): ${cell(r.error ?? r.judge?.reason ?? 'Judge disabled; review required.')}`);
      if (r.checks?.mustSayMisses.length) lines.push(`  - mustSay misses: ${cell(JSON.stringify(r.checks.mustSayMisses))}`);
      if (r.checks?.mustNotSayHits.length) lines.push(`  - mustNotSay hits: ${cell(JSON.stringify(r.checks.mustNotSayHits))}`);
    }
    lines.push('', '### Grounding', '');
    for (const r of a.cases) if (r.judge?.unsupportedClaims.length) lines.push(`- ${cell(r.case.id)}: ${cell(r.judge.unsupportedClaims.join('; '))}`);
    for (const r of a.cases) if (r.judge?.unsupportedInContextClaims?.length) lines.push(`- ${cell(r.case.id)} (unsupported by supplied context): ${cell(r.judge.unsupportedInContextClaims.join('; '))}`);
    lines.push('', '### Retrieval stage recall', '', 'Each stage uses its best complete gold option; absent stages are unmeasured. Filtered retains relevance-qualified candidates, reranked applies the top-eight cutoff. Selected means packed before adequacy, while Recall@k below describes evidence actually supplied to generation.', '', '| Stage | Measured cases | Mean recall |', '| --- | ---: | ---: |', ...Object.entries(s.retrievalStages).map(([stage, metric]) => `| ${stage} | ${metric.cases} | ${cell(metric.meanRecall)} |`), '', '| Case | Stage | k | Recall@k | First gold rank | Gold option |', '| --- | --- | ---: | ---: | ---: | ---: |');
    for (const r of a.cases) for (const [stage, metric] of Object.entries(r.retrievalStages ?? {})) lines.push(`| ${cell(r.case.id)} | ${stage} | ${metric.k} | ${cell(metric.recallAtK)} | ${cell(metric.firstGoldRank)} | ${cell(metric.selectedGoldSetIndex)} |`);
    for (const r of a.cases) if (r.retrievalLosses) lines.push(`- ${cell(r.case.id)} excluded IDs by decision: ${cell(JSON.stringify(r.retrievalLosses))}`);
    lines.push('', '### Retrieval and stage timings', '', '| Case | Recall@k | First gold rank | Gold set index (0-based) | Retrieved unused | Dropped by rerank | Stages ms |', '| --- | ---: | ---: | ---: | ---: | --- | --- |');
    for (const r of a.cases) if (r.retrieval || r.answer?.timings.stages) lines.push(`| ${cell(r.case.id)} | ${cell(r.retrieval?.recallAtK)} | ${cell(r.retrieval?.firstGoldRank)} | ${cell(r.retrieval?.selectedGoldSetIndex)} | ${cell(r.retrieval?.retrievedButUnused)} | ${cell(r.retrieval?.droppedByRerank?.join(', '))} | ${cell(r.answer?.timings.stages ? JSON.stringify(r.answer.timings.stages) : null)} |`);
    lines.push('');
  }
  return lines.join('\n');
}
export async function writeRun(out: string, run: Run): Promise<string> {
  await mkdir(out, { recursive: true });
  const stamp = run.startedAt.slice(0, 16).replace(/:/g, '');
  const base = path.join(out, `${stamp}-${run.corpus.version.slice(0, 8)}`);
  let dir = base;
  for (let i = 1; ; i++) {
    try { await mkdir(dir); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      dir = `${base}-${i}`; // Preserve runs made in the same minute.
    }
  }
  const summaries = run.approaches.map(a => ({ name: a.name, status: a.status, ...summarize(a) }));
  await writeFile(path.join(dir, 'results.json'), JSON.stringify({ ...run, summaries }, null, 2) + '\n');
  await writeFile(path.join(dir, 'report.md'), report(run));
  await appendFile(path.join(out, 'runs.jsonl'), JSON.stringify({ startedAt: run.startedAt, corpusVersion: run.corpus.version, promptTemplateVersion: run.promptTemplateVersion, retrievalConfigVersion: run.retrievalConfigVersion, answerModel: run.answerModel, judgeModel: run.judgeModel, dir, summaries }) + '\n');
  return dir;
}
