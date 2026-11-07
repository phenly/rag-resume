import type { Corpus } from '../corpus';
import type { Answer, Approach, ApproachResult, CaseResult, EvalCase, JudgeOutput, Usage } from './types';
import { dollars } from './pricing';
export type Judge = (c: EvalCase, answer: string) => Promise<{ output: JudgeOutput; usage: Usage; usageIncomplete?: boolean }>;
export function checks(c: EvalCase, text: string) {
  return { mustSayMisses: c.mustSay.filter(p => !new RegExp(p, 'i').test(text)), mustNotSayHits: c.mustNotSay.filter(p => new RegExp(p, 'i').test(text)) };
}
export function grade(c: EvalCase, answer: Answer, judge?: JudgeOutput): Pick<CaseResult, 'status' | 'checks' | 'retrieval'> {
  const checked = checks(c, answer.text);
  const leak = judge?.leaked || (c.category === 'leak-probe' && checked.mustNotSayHits.length > 0);
  const status = leak ? 'leak-failure' : !judge ? 'unjudged' : checked.mustSayMisses.length || checked.mustNotSayHits.length || !judge.rubricMet || judge.unsupportedClaims.length ? 'fail' : 'pass';
  const ids = answer.retrievedChunkIds === undefined ? undefined : [...new Set(answer.retrievedChunkIds)];
  const evidenceSets = c.goldChunkSets ?? [c.goldChunks];
  let selectedGoldSetIndex = 0;
  let bestRecall = -1;
  evidenceSets.forEach((set, index) => {
    const recall = set.length ? set.filter(id => ids?.includes(id)).length / set.length : 0;
    // Strict comparison preserves declaration order on ties, including zero hits.
    if (recall > bestRecall) { bestRecall = recall; selectedGoldSetIndex = index; }
  });
  const gold = new Set(evidenceSets[selectedGoldSetIndex]);
  const first = ids?.findIndex(id => gold.has(id)) ?? -1;
  return { status, checks: checked, ...(ids ? { retrieval: {
    k: ids.length, recallAtK: gold.size ? new Set(ids.filter(id => gold.has(id))).size / gold.size : null,
    firstGoldRank: first < 0 ? null : first + 1,
    ...(c.goldChunkSets ? { selectedGoldSetIndex } : {}),
    ...(judge ? { retrievedButUnused: ids.filter(id => !judge.usedChunkIds.includes(id)).length } : {}),
    ...(answer.droppedByRerank ? { droppedByRerank: answer.droppedByRerank } : {}),
  } } : {}) };
}
/** Unknown interrupted provider usage remains unknown rather than free. */
export function retrievalCost(trace: Answer['retrievalTrace']): { dollars: number | null; knownDollars: number; incomplete: boolean } {
  if (!trace) return { dollars: 0, knownDollars: 0, incomplete: false };
  const receipts = [...(trace.embedding ? [trace.embedding] : []), ...(trace.rerank?.calls ?? [])];
  const incomplete = receipts.some(receipt => receipt.status !== 'complete');
  const knownDollars = receipts.reduce((sum, receipt) => sum + (receipt.status === 'complete' ? receipt.costUsd : 0), 0);
  return { dollars: incomplete ? null : knownDollars, knownDollars, incomplete };
}
export async function runApproach(options: { approach?: Approach; corpus: Corpus; cases: EvalCase[]; concurrency: number; model: string; judgeModel: string; judge?: Judge }): Promise<ApproachResult> {
  const { approach, corpus, cases, model, judgeModel, judge } = options;
  if (!approach) return { name: 'rag', status: 'not built', cases: [], indexFreshness: null, embeddingDollars: null };
  await approach.prepare(corpus);
  const results: CaseResult[] = new Array(cases.length);
  async function run(index: number) {
    const c = cases[index];
    const result: CaseResult = { case: c, status: 'answer-error', judgeDollars: 0 };
    results[index] = result;
    try {
      result.answer = await approach!.answer(c.question);
      const retrieval = retrievalCost(result.answer.retrievalTrace);
      result.retrievalDollars = retrieval.dollars;
      result.retrievalKnownDollars = retrieval.knownDollars;
      result.retrievalCostIncomplete = retrieval.incomplete;
      result.answerDollars = result.answer.effectiveApproach === 'deterministic' ? 0 : dollars(model, result.answer.usage);
      result.answerCostIncomplete = !!result.answer.usageIncomplete;
      Object.assign(result, grade(c, result.answer));
    } catch (e) {
      result.error = String(e);
      const failure = e as { usage?: Usage; timings?: Answer['timings']; usageIncomplete?: boolean; retrievalTrace?: Answer['retrievalTrace'] };
      result.retrievalTrace = failure.retrievalTrace;
      const retrieval = retrievalCost(failure.retrievalTrace);
      result.retrievalDollars = retrieval.dollars;
      result.retrievalKnownDollars = retrieval.knownDollars;
      result.retrievalCostIncomplete = retrieval.incomplete;
      result.answerUsage = failure.usage;
      result.answerTimings = failure.timings;
      result.answerDollars = failure.usage ? dollars(model, failure.usage) : null;
      result.answerCostIncomplete = !failure.usage || !!failure.usageIncomplete;
      return;
    }
    if (judge) {
      try {
        const judged = await judge(c, result.answer!.text);
        result.judgeUsage = judged.usage;
        result.judgeCostIncomplete = !!judged.usageIncomplete;
        result.judgeDollars = dollars(judgeModel, judged.usage);
        result.judge = judged.output;
        Object.assign(result, grade(c, result.answer!, judged.output));
      } catch (e) {
        // A known regex leak remains a leak even when judging fails.
        if (result.status !== 'leak-failure') result.status = 'judge-error';
        result.error = String(e);
        const { usage, usageIncomplete } = e as { usage?: Usage; usageIncomplete?: boolean };
        result.judgeDollars = null;
        result.judgeCostIncomplete = !usage || !!usageIncomplete;
        if (usage) { result.judgeUsage = usage; result.judgeDollars = dollars(judgeModel, usage); }
      }
    }
  }
  if (cases.length) await run(0); // Finish cold request before any concurrent requests.
  let next = 1;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(0, cases.length - 1)) }, async () => {
    while (next < cases.length) await run(next++);
  }));
  const traces = results.flatMap(result => (result.answer?.retrievalTrace ?? result.retrievalTrace) ? [result.answer?.retrievalTrace ?? result.retrievalTrace!] : []);
  const embeddings = traces.flatMap(trace => trace.embedding ? [trace.embedding] : []);
  return { name: approach.name, status: 'complete', cases: results, indexFreshness: approach.name === 'whole' ? null : traces.length && traces.every(trace => trace.indexVersion) ? 'matching' : 'unavailable', embeddingDollars: embeddings.some(item => item.status !== 'complete') ? null : embeddings.reduce((sum, item) => sum + (item.status === 'complete' ? item.costUsd : 0), 0) };
}
