import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { categories, type ApproachResult, type CaseResult } from './types';
import type { countCorpus } from './corpus';
export type Run = {
  version: 1; promptTemplateVersion?: string; startedAt: string; answerModel: string; judgeModel: string | null;
  corpus: { version: string; chunkCount: number; tokens?: Awaited<ReturnType<typeof countCorpus>>; tokenError?: string };
  approaches: ApproachResult[];
};
const eligible = (r: CaseResult) => r.case.status !== 'open' && r.case.category !== 'leak-probe';
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
export function summarize(a: ApproachResult) {
  const scored = a.cases.filter(eligible);
  const passing = scored.filter(r => r.status === 'pass').length;
  const judged = scored.filter(r => !['unjudged'].includes(r.status));
  const sumCost = (key: 'answerDollars' | 'judgeDollars', rows = a.cases) =>
    rows.some(r => r[key] == null || (key === 'answerDollars' ? r.answerCostIncomplete : r.judgeCostIncomplete)) ? null : rows.reduce((s, r) => s + r[key]!, 0);
  const answerDollars = sumCost('answerDollars');
  const judgeDollars = sumCost('judgeDollars');
  const eligibleAnswerDollars = sumCost('answerDollars', scored);
  const eligibleJudgeDollars = sumCost('judgeDollars', scored);
  const usage = a.cases.flatMap(r => r.answer ? [r.answer.usage] : r.answerUsage ? [r.answerUsage] : []);
  const input = usage.reduce((s, u) => s + u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), 0);
  const speeds = Object.fromEntries(['cold', 'warm', 'uncached'].map(kind => {
    const answers = a.cases.flatMap(r => r.answer ? [r.answer] : []).filter(a =>
      kind === 'cold' ? (a.usage.cache_creation_input_tokens ?? 0) > 0 : kind === 'warm' ? !(a.usage.cache_creation_input_tokens ?? 0) && (a.usage.cache_read_input_tokens ?? 0) > 0 : !(a.usage.cache_creation_input_tokens ?? 0) && !(a.usage.cache_read_input_tokens ?? 0));
    return [kind, { count: answers.length, firstTokenMs: mean(answers.flatMap(a => a.timings.firstTokenMs === null ? [] : [a.timings.firstTokenMs])), totalMs: mean(answers.map(a => a.timings.totalMs)) }];
  }));
  return {
    eligible: scored.length, passing, passRate: scored.length && judged.length === scored.length ? passing / scored.length : null,
    categories: Object.fromEntries(categories.map(category => {
      const rows = scored.filter(r => r.case.category === category);
      return [category, { eligible: rows.length, passing: rows.filter(r => r.status === 'pass').length,
        passRate: rows.length && rows.every(r => r.status !== 'unjudged') ? rows.filter(r => r.status === 'pass').length / rows.length : null }];
    })),
    leakFailures: a.cases.filter(r => r.status === 'leak-failure').map(r => r.case.id),
    answerDollars, judgeDollars, totalDollars: answerDollars === null || judgeDollars === null ? null : answerDollars + judgeDollars,
    costIncomplete: answerDollars === null || judgeDollars === null,
    knownDollars: a.cases.reduce((s, r) => s + (r.answerDollars ?? 0) + (r.judgeDollars ?? 0), 0),
    dollarsPerPassingAnswer: passing && eligibleAnswerDollars !== null && eligibleJudgeDollars !== null ? (eligibleAnswerDollars + eligibleJudgeDollars) / passing : null,
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
    `Prompt template: ${run.promptTemplateVersion ?? run.corpus.tokens?.promptTemplateVersion ?? 'historical/unrecorded'}.`, '',
    `Exact prompt tokens: ${t ?? 'unavailable'} — ${pressure}.`, run.corpus.tokens?.note ?? (run.corpus.tokenError ? `Token counting error: ${run.corpus.tokenError}` : 'Token counting skipped: no built approach selected.'), '',
    '| Corpus part | API tokens |', '| --- | ---: |', ...Object.entries(run.corpus.tokens?.parts ?? {}).map(([k, v]) => `| ${k} | ${v} |`), ''];
  for (const a of run.approaches) {
    lines.push(`## ${a.name} — ${a.status}`, '');
    if (a.status === 'not built') { lines.push('This approach is not built; no questions were sent.', ''); continue; }
    const s = summarize(a);
    lines.push(`Pass rate: **${pct(s.passRate)}** (${s.passing}/${s.eligible}; excludes open cases and all leak probes). Unjudged runs have no pass rate.`, '',
      '| Category | Pass / eligible | Rate |', '| --- | ---: | ---: |',
      ...Object.entries(s.categories).map(([k, v]) => `| ${k} | ${v.passing}/${v.eligible} | ${pct(v.passRate)} |`), '',
      `Leak failures: ${s.leakFailures.join(', ') || 'none'}.`, '',
      '| Cost / operation | Value |', '| --- | ---: |',
      ...Object.entries({ answerDollars: s.answerDollars, judgeDollars: s.judgeDollars, totalDollars: s.totalDollars, costIncomplete: s.costIncomplete, knownDollars: s.knownDollars, dollarsPerPassingAnswer: s.dollarsPerPassingAnswer, embeddingDollars: a.embeddingDollars, cacheHitRate: pct(s.cacheHitRate), indexFreshness: a.indexFreshness }).map(([k, v]) => `| ${k} | ${cell(v)} |`), '',
      '| Cache state | Questions | Mean first token ms | Mean total ms |', '| --- | ---: | ---: | ---: |',
      ...Object.entries(s.speeds).map(([k, v]) => `| ${k} | ${v.count} | ${cell(v.firstTokenMs)} | ${cell(v.totalMs)} |`), '',
      ...(s.speeds.cold.count === 0 ? ['Every question hit a warm cache; no cold timing was measured.', ''] : []),
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
  await appendFile(path.join(out, 'runs.jsonl'), JSON.stringify({ startedAt: run.startedAt, corpusVersion: run.corpus.version, promptTemplateVersion: run.promptTemplateVersion, answerModel: run.answerModel, judgeModel: run.judgeModel, dir, summaries }) + '\n');
  return dir;
}
