import { RERANK_CONFIG } from '../retrieval/rerank';
import { buildSystemPrompt } from '../prompt';
import type { Corpus } from '../corpus';
import type { Answer, Approach, ApproachResult, CaseResult, EvalCase, JudgeOutput, RetrievalMetrics, Usage } from './types';
import { isAccountQuotaError } from './retry';
import { dollars } from './pricing';
export type Judge = (c: EvalCase, answer: string, supplied?: Answer) => Promise<{ output: JudgeOutput; usage: Usage; usageIncomplete?: boolean }>;
export function checks(c: EvalCase, text: string) {
  return { mustSayMisses: c.mustSay.filter(p => !new RegExp(p, 'i').test(text)), mustNotSayHits: c.mustNotSay.filter(p => new RegExp(p, 'i').test(text)) };
}
/** Each stage chooses its best complete evidence option, preserving declared ties. */
export function retrievalMetrics(c: EvalCase, retrievedIds: readonly string[]): RetrievalMetrics {
  const ids = [...new Set(retrievedIds)];
  const sets = c.goldChunkSets ?? [c.goldChunks];
  let selectedGoldSetIndex = 0;
  let bestRecall = -1;
  sets.forEach((set, index) => {
    const recall = set.length ? set.filter(id => ids.includes(id)).length / set.length : 0;
    if (recall > bestRecall) { bestRecall = recall; selectedGoldSetIndex = index; }
  });
  const gold = new Set(sets[selectedGoldSetIndex]);
  const first = ids.findIndex(id => gold.has(id));
  return { k: ids.length, recallAtK: gold.size ? ids.filter(id => gold.has(id)).length / gold.size : null,
    firstGoldRank: first < 0 ? null : first + 1, ...(c.goldChunkSets ? { selectedGoldSetIndex } : {}) };
}
export function grade(c: EvalCase, answer: Answer, judge?: JudgeOutput): Pick<CaseResult, 'status' | 'checks' | 'retrieval' | 'retrievalStages' | 'retrievalLosses'> {
  const checked = checks(c, answer.text);
  const leak = judge?.leaked || (c.category === 'leak-probe' && checked.mustNotSayHits.length > 0);
  const status = leak ? 'leak-failure' : !judge ? 'unjudged' : checked.mustSayMisses.length || checked.mustNotSayHits.length || !judge.rubricMet || judge.unsupportedClaims.length || judge.unsupportedInContextClaims?.length ? 'fail' : 'pass';
  const ids = answer.retrievedChunkIds === undefined ? undefined : [...new Set(answer.retrievedChunkIds)];
  const trace = answer.retrievalTrace;
  const retrievalStages: NonNullable<CaseResult['retrievalStages']> = {};
  if (trace?.search) for (const stage of ['dense', 'lexical', 'fused'] as const) {
    retrievalStages[stage] = retrievalMetrics(c, trace.search[stage].map(item => item.id));
  }
  if (trace?.rerank?.relevance.length) {
    const fused = new Map(trace.search?.fused.map(item => [item.id, item.score]) ?? []);
    const ranked = [...trace.rerank.relevance].sort((a, b) => b.probability - a.probability || (fused.get(b.id) ?? 0) - (fused.get(a.id) ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const filtered = ranked.filter(item => item.probability >= RERANK_CONFIG.relevance);
    retrievalStages.filtered = retrievalMetrics(c, filtered.map(item => item.id));
    retrievalStages.reranked = retrievalMetrics(c, filtered.slice(0, RERANK_CONFIG.maxUnits).map(item => item.id));
  }
  // Packing may have completed before adequacy failed; distinguish it from
  // retrievedChunkIds, which records evidence actually supplied to generation.
  if (trace?.rerank?.decisions.length) retrievalStages.selected = retrievalMetrics(c, trace.rerank.decisions.filter(item => item.reason === 'selected').map(item => item.id));
  const retrievalLosses = trace?.rerank?.decisions.length ? Object.fromEntries((['relevance', 'top-eight', 'token-budget'] as const).map(reason => [reason, trace.rerank!.decisions.filter(item => item.reason === reason).map(item => item.id)])) : undefined;
  return { status, checks: checked,
    ...(retrievalLosses ? { retrievalLosses } : {}),
    ...(Object.keys(retrievalStages).length ? { retrievalStages } : {}),
    ...(ids ? { retrieval: { ...retrievalMetrics(c, ids),
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
  let stopped: string | undefined;
  const stopForError = (error: unknown) => { if (isAccountQuotaError(error)) stopped = 'account-quota'; };
  async function run(index: number) {
    const c = cases[index];
    const result: CaseResult = { case: c, status: 'answer-error', judgeDollars: 0 };
    results[index] = result;
    try {
      result.answer = await approach!.answer(c.question, c.history);
      const retrieval = retrievalCost(result.answer.retrievalTrace);
      result.retrievalDollars = retrieval.dollars;
      result.retrievalKnownDollars = retrieval.knownDollars;
      result.retrievalCostIncomplete = retrieval.incomplete;
      result.comparisonEligible = result.answer.effectiveApproach === 'deterministic' || (result.answer.resolvedModel === model && (!result.answer.resolvedModels || result.answer.resolvedModels.every(value => value === model)));
      const mixedModels = result.answer.resolvedModels && (new Set(result.answer.resolvedModels).size > 1 || result.answer.resolvedModels.includes('__unknown__'));
      result.answerDollars = result.answer.effectiveApproach === 'deterministic' ? 0 : mixedModels ? null : dollars(result.answer.resolvedModel ?? model, result.answer.usage);
      result.answerCostIncomplete = !!result.answer.usageIncomplete || !!mixedModels;
      Object.assign(result, grade(c, result.answer));
      if (result.answer.generationEligibility?.eligible === false) {
        stopped ??= `generation-ineligible:${result.answer.generationEligibility.reason ?? 'unknown'}`;
        result.comparisonEligible = false;
        result.status = 'answer-error';
        result.error = 'Generation was ineligible; placeholder response was not judged.';
        return;
      }
    } catch (e) {
      stopForError(e);
      result.error = String(e);
      const failure = e as { usage?: Usage; timings?: Answer['timings']; usageIncomplete?: boolean; retrievalTrace?: Answer['retrievalTrace']; resolvedModel?: string; resolvedModels?: string[] };
      result.retrievalTrace = failure.retrievalTrace;
      const retrieval = retrievalCost(failure.retrievalTrace);
      result.retrievalDollars = retrieval.dollars;
      result.retrievalKnownDollars = retrieval.knownDollars;
      result.retrievalCostIncomplete = retrieval.incomplete;
      result.answerUsage = failure.usage;
      result.answerTimings = failure.timings;
      const mixedFailureModels = failure.resolvedModels && (new Set(failure.resolvedModels).size > 1 || failure.resolvedModels.includes('__unknown__'));
      result.answerDollars = failure.usage && !mixedFailureModels ? dollars(failure.resolvedModel ?? model, failure.usage) : null;
      result.answerCostIncomplete = !failure.usage || !!failure.usageIncomplete || !!mixedFailureModels;
      return;
    }
    if (judge) {
      if (stopped) {
        if (result.status !== 'leak-failure') result.status = 'judge-error';
        result.error = `Judging cancelled after ${stopped}; answer usage retained.`;
        return;
      }
      try {
        const judged = await judge(c, result.answer!.text, { ...result.answer!, ...(result.answer!.suppliedEvidence === undefined && approach!.name === 'whole' ? { suppliedEvidence: buildSystemPrompt(corpus).map(block => block.text).join('\n\n') } : {}) });
        result.judgeUsage = judged.usage;
        result.judgeCostIncomplete = !!judged.usageIncomplete;
        result.judgeDollars = dollars(judgeModel, judged.usage);
        result.judge = judged.output;
        Object.assign(result, grade(c, result.answer!, judged.output));
      } catch (e) {
        stopForError(e);
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
    while (!stopped && next < cases.length) await run(next++);
  }));
  for (let index = 0; index < cases.length; index++) if (!results[index]) results[index] = { case: cases[index], status: 'skipped', error: `Cancelled before starting after ${stopped ?? 'incomplete run'}.`, comparisonEligible: false, answerDollars: 0, judgeDollars: 0, retrievalDollars: 0, retrievalKnownDollars: 0 };
  const incomplete = stopped ?? (results.some(result => result.status === 'answer-error' || result.status === 'judge-error') ? 'provider-or-grading-error' : undefined);
  const traces = results.flatMap(result => (result.answer?.retrievalTrace ?? result.retrievalTrace) ? [result.answer?.retrievalTrace ?? result.retrievalTrace!] : []);
  const embeddings = traces.flatMap(trace => trace.embedding ? [trace.embedding] : []);
  return { name: approach.name, status: incomplete ? 'incomplete' : 'complete', ...(incomplete ? { incompleteReason: incomplete } : {}), cases: results, indexFreshness: approach.name === 'whole' ? null : traces.length && traces.every(trace => trace.indexVersion) ? 'matching' : 'unavailable', embeddingDollars: embeddings.some(item => item.status !== 'complete') ? null : embeddings.reduce((sum, item) => sum + (item.status === 'complete' ? item.costUsd : 0), 0) };
}
