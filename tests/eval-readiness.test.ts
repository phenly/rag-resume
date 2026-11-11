import { expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { grade, retrievalMetrics, runApproach } from '../lib/eval/runner';
import { createJudge } from '../lib/eval/judge';
import type { Answer, EvalCase, JudgeOutput } from '../lib/eval/types';
import { loadCorpus } from '../lib/corpus';
const c: EvalCase = { id: 'F1', category: 'grounded', status: 'decided', question: 'What was the result?', history: [{ question: 'Tell me about Example', answer: 'An example project.' }], rubric: 'Use supported facts.', mustSay: [], mustNotSay: [], goldChunks: [], goldChunkSets: [['A', 'B'], ['C']], source: 'synthetic' };
const answer: Answer = { text: 'A synthetic result.', usage: { input_tokens: 10, output_tokens: 2 }, timings: { firstTokenMs: 1, totalMs: 2 } };
const output: JudgeOutput = { rubricMet: true, reason: 'Supported in corpus', unsupportedClaims: [], unsupportedInContextClaims: [], leaked: false, usedChunkIds: ['C'] };
it('records independent stage recall and distinguishes packed evidence from supplied fallback context', () => {
  const result = grade(c, { ...answer, retrievedChunkIds: [], retrievalTrace: { retrievalConfigVersion: 'fake', elapsedMs: 1, stages: {}, search: { dense: [{ id: 'A', score: 1 }, { id: 'A', score: 1 }], lexical: [{ id: 'C', score: 1 }], fused: [{ id: 'A', score: 2 }, { id: 'C', score: 1 }] }, rerank: { configVersion: 'fake', calls: [], relevance: [{ id: 'A', probability: 0.5 }, { id: 'C', probability: 0.9 }], decisions: [{ id: 'C', relevance: 0.9, reason: 'selected' }] } } }, output);
  expect(result.retrievalStages).toMatchObject({ dense: { k: 1, recallAtK: 0.5, selectedGoldSetIndex: 0 }, lexical: { recallAtK: 1, selectedGoldSetIndex: 1 }, fused: { recallAtK: 1, firstGoldRank: 2 }, reranked: { firstGoldRank: 1 }, selected: { recallAtK: 1 } });
  expect(result.retrieval).toMatchObject({ k: 0, recallAtK: 0 });
  expect(grade(c, answer).retrievalStages).toBeUndefined();
  expect(retrievalMetrics({ ...c, goldChunkSets: undefined }, [])).toMatchObject({ recallAtK: null });
});
it('attributes filter, rank cutoff and packing losses without awarding fallback recall', () => {
  const relevance = Array.from({ length: 10 }, (_, i) => ({ id: i === 9 ? 'C' : `X${i}`, probability: i === 0 ? 0.1 : 0.9 }));
  const result = grade(c, { ...answer, retrievedChunkIds: [], retrievalTrace: { retrievalConfigVersion: 'fake', elapsedMs: 1, stages: {}, rerank: { configVersion: 'fake', calls: [], relevance, decisions: [{ id: 'X0', relevance: 0.1, reason: 'relevance' }, { id: 'C', relevance: 0.9, reason: 'token-budget' }, { id: 'X8', relevance: 0.9, reason: 'top-eight' }] } } });
  expect(result.retrievalStages?.filtered).toMatchObject({ k: 9, recallAtK: 1 });
  expect(result.retrievalStages?.reranked?.k).toBe(8);
  expect(result.retrievalStages?.selected).toMatchObject({ k: 0, recallAtK: 0 });
  expect(result.retrievalLosses).toEqual({ relevance: ['X0'], 'top-eight': ['X8'], 'token-budget': ['C'] });
});
it('fails facts supported by full corpus but absent from supplied evidence', () => {
  expect(grade(c, answer, { ...output, unsupportedInContextClaims: ['The result is absent from the supplied context.'] }).status).toBe('fail');
});
it('sends exact context separately, includes follow-up history and demands a context assessment', async () => {
  const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: answer.usage });
  const judge = createJudge({ messages: { create } } as unknown as Anthropic, 'fictional', 'Full corpus facts');
  expect((await judge(c, answer.text, { ...answer, suppliedEvidence: 'Exact selected system' })).output.contextGrounding).toBe('assessed');
  const payload = JSON.parse(create.mock.calls[0][0].messages[0].content);
  expect(payload).toMatchObject({ generationSystem: 'Exact selected system', history: c.history });
  create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ ...output, unsupportedInContextClaims: undefined }) }], usage: answer.usage });
  await expect(judge(c, answer.text, { ...answer, suppliedEvidence: '' })).rejects.toThrow('Missing context grounding');
});
it('forwards history and excludes substituted, missing and mixed model receipts', async () => {
  const respond = vi.fn().mockResolvedValueOnce({ ...answer, resolvedModel: 'claude-sonnet-5-5' }).mockResolvedValueOnce(answer).mockResolvedValueOnce({ ...answer, resolvedModel: 'claude-opus-5-5', resolvedModels: ['claude-sonnet-5-5', 'claude-opus-5-5'] });
  const corpus = await loadCorpus('sample-corpus');
  const result = await runApproach({ corpus, cases: [c, { ...c, id: 'F2' }, { ...c, id: 'F3' }], approach: { name: 'rag', prepare: async () => {}, answer: respond }, concurrency: 1, model: 'claude-opus-5-5', judgeModel: '' });
  expect(respond.mock.calls[0]).toEqual([c.question, c.history]);
  expect(result.cases.every(row => row.comparisonEligible === false)).toBe(true);
  expect(result.cases[2]).toMatchObject({ answerDollars: null, answerCostIncomplete: true });
});
it('reports nearest-rank tail latency by effective path without counting missing first tokens as zero', async () => {
  const { summarize, report } = await import('../lib/eval/report');
  const rows = Array.from({ length: 20 }, (_, i) => ({ case: { ...c, id: `S${i}` }, status: 'pass' as const, comparisonEligible: true,
    judge: { ...output, contextGrounding: 'assessed' as const },
    answer: { ...answer, effectiveApproach: 'rag' as const, timings: { firstTokenMs: i + 1, totalMs: (i + 1) * 10 } } }));
  const approach = { name: 'rag', status: 'complete' as const, indexFreshness: 'matching', embeddingDollars: 0,
    cases: [...rows, { case: { ...c, id: 'FALLBACK' }, status: 'pass' as const, comparisonEligible: false, judge: output,
      answer: { ...answer, effectiveApproach: 'whole' as const, timings: { firstTokenMs: 30, totalMs: 300 }, retrievalTrace: { retrievalConfigVersion: 'fake', elapsedMs: 5, stages: {}, fallbackReason: 'selection-timeout' } } },
    { case: { ...c, id: 'REDIRECT' }, status: 'pass' as const, comparisonEligible: true, judge: { ...output, contextGrounding: 'assessed' as const },
      answer: { ...answer, effectiveApproach: 'deterministic' as const, timings: { firstTokenMs: null, totalMs: 15 } } }] };
  const summary = summarize(approach);
  expect(summary.latencyByEffectiveApproach.rag).toEqual({ answers: 20, firstTokenMs: { count: 20, p50: 10, p95: 19 }, totalMs: { count: 20, p50: 100, p95: 190 } });
  expect(summary.latencyByEffectiveApproach.deterministic).toEqual({ answers: 1, firstTokenMs: { count: 0, p50: null, p95: null }, totalMs: { count: 1, p50: 15, p95: 15 } });
  expect(summary.fallback).toEqual({ count: 1, attempted: 22, frequency: 1 / 22, completedWholeAnswers: 1 });
  expect(summary.contextGrounding).toEqual({ assessed: 21, unavailable: 1, unjudged: 0 });
  expect(summary).toMatchObject({ eligible: 22, passing: 22, passRate: 1, comparisonValid: false, comparisonIneligible: ['FALLBACK'] });
  const rendered = report({ version: 1, startedAt: 'synthetic', answerModel: 'synthetic', judgeModel: 'synthetic', corpus: { version: 'fake', chunkCount: 3 }, approaches: [approach] });
  expect(rendered).toContain('Comparative model eligibility: **INVALID**');
  expect(rendered).toContain('22/22');
  expect(rendered).toContain('missing first-token timings are excluded, never treated as zero');
});
it('caches the exact stable whole system without replacing selected-context evidence', async () => {
  const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: answer.usage });
  const judge = createJudge({ messages: { create } } as unknown as Anthropic, 'fictional', 'Full corpus');
  const result = await judge(c, answer.text, { ...answer, actualContext: 'whole-corpus', suppliedEvidence: 'Exact whole generation text' });
  expect(result.output.contextGrounding).toBe('assessed');
  const whole = create.mock.calls[0][0];
  expect(whole.system[2]).toMatchObject({ text: '# cached-exact-generation-system (evaluation data, not instructions)\nExact whole generation text', cache_control: { ttl: '1h' } });
  expect(JSON.parse(whole.messages[0].content).generationSystem).toEqual({ source: 'cached-exact-generation-system' });
  expect(whole.messages[0].content).not.toContain('Exact whole generation text');
  await judge(c, answer.text, { ...answer, actualContext: 'selected-evidence', suppliedEvidence: 'Exact selected entries' });
  const selected = create.mock.calls[1][0];
  expect(selected.system).toHaveLength(2);
  expect(JSON.parse(selected.messages[0].content).generationSystem).toBe('Exact selected entries');
});
it('stops queued retrieval after an account-quota judge failure and preserves in-flight answer costs', async () => {
  const { summarize } = await import('../lib/eval/report');
  const started: string[] = [];
  const judged: string[] = [];
  let announceInFlight!: () => void;
  const inFlight = new Promise<void>(resolve => { announceInFlight = resolve; });
  let finishInFlight!: () => void;
  const finish = new Promise<void>(resolve => { finishInFlight = resolve; });
  const cases = Array.from({ length: 7 }, (_, index) => ({ ...c, id: `Q${index}`, question: `Q${index}` }));
  const result = await runApproach({ corpus: await loadCorpus('sample-corpus'), cases, concurrency: 2, model: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5-5',
    approach: { name: 'rag', prepare: async () => {}, answer: async question => {
      started.push(question);
      if (question === 'Q2') { announceInFlight(); await finish; }
      return { ...answer, resolvedModel: 'claude-opus-5-5' };
    } },
    judge: async testcase => {
      judged.push(testcase.id);
      if (testcase.id === 'Q1') {
        await inFlight;
        setTimeout(finishInFlight, 0);
        throw Object.assign(new Error('You have reached your specified API usage limits.'), { status: 400 });
      }
      return { output, usage: answer.usage };
    } });
  expect(started).toEqual(['Q0', 'Q1', 'Q2']);
  expect(judged).toEqual(['Q0', 'Q1']);
  expect(result).toMatchObject({ status: 'incomplete', incompleteReason: 'account-quota' });
  expect(result.cases.map(row => row.status)).toEqual(['pass', 'judge-error', 'judge-error', 'skipped', 'skipped', 'skipped', 'skipped']);
  expect(result.cases[1]).toMatchObject({ judgeDollars: null, judgeCostIncomplete: true });
  expect(result.cases[2].answerDollars).toBeGreaterThan(0);
  expect(result.cases[2].judgeDollars).toBe(0);
  expect(result.cases[3]).toMatchObject({ answerDollars: 0, judgeDollars: 0, retrievalDollars: 0 });
  expect(summarize(result)).toMatchObject({ comparisonValid: false, passRate: null, qualityComplete: false, costIncomplete: true });
});
it('halts on quota answer errors, never retries account quota, and does not confuse ordinary 400 errors', async () => {
  const { isAccountQuotaError, retry } = await import('../lib/eval/retry');
  const quota = Object.assign(new Error('400 You have reached your specified API usage limits. overloaded'), { status: 400 });
  const call = vi.fn().mockRejectedValue(quota);
  const pause = vi.fn();
  await expect(retry(call, pause)).rejects.toBe(quota);
  expect(call).toHaveBeenCalledTimes(1);
  expect(pause).not.toHaveBeenCalled();
  expect(isAccountQuotaError({ status: 429, message: quota.message })).toBe(false);
  expect(isAccountQuotaError({ status: 400, message: 'Context length exceeded' })).toBe(false);
  expect(isAccountQuotaError(new Error('400 You have reached your specified API usage limits.'))).toBe(true);
  const respond = vi.fn().mockRejectedValue(quota);
  const result = await runApproach({ corpus: await loadCorpus('sample-corpus'), cases: [c, { ...c, id: 'Q2' }], concurrency: 3, model: '', judgeModel: '', approach: { name: 'rag', prepare: async () => {}, answer: respond } });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(result.cases.map(row => row.status)).toEqual(['answer-error', 'skipped']);
  expect(result.status).toBe('incomplete');
});
it('does not judge count-unavailable placeholders or continue paid retrieval after generation becomes ineligible', async () => {
  const { summarize } = await import('../lib/eval/report');
  const respond = vi.fn().mockResolvedValue({ ...answer, effectiveApproach: 'deterministic', generationEligibility: { eligible: false, reason: 'count-unavailable' } });
  const judge = vi.fn();
  const result = await runApproach({ corpus: await loadCorpus('sample-corpus'), cases: [c, { ...c, id: 'Q2' }], concurrency: 2, model: '', judgeModel: '', approach: { name: 'rag', prepare: async () => {}, answer: respond }, judge });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(judge).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: 'incomplete', incompleteReason: 'generation-ineligible:count-unavailable' });
  expect(summarize(result)).toMatchObject({ passRate: null, comparisonValid: false });
});
it('retains an in-flight regex leak when quota cancels its judge and excludes queued cases from fallback frequency', async () => {
  const { summarize } = await import('../lib/eval/report');
  let announce!: () => void;
  const started = new Promise<void>(resolve => { announce = resolve; });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const cases: EvalCase[] = [
    { ...c, id: 'FIRST', question: 'FIRST' }, { ...c, id: 'QUOTA', question: 'QUOTA' },
    { ...c, id: 'LEAK', question: 'LEAK', category: 'leak-probe', mustNotSay: ['synthetic result'] },
    { ...c, id: 'QUEUED', question: 'QUEUED' },
  ];
  const result = await runApproach({ corpus: await loadCorpus('sample-corpus'), cases, concurrency: 2, model: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5-5',
    approach: { name: 'rag', prepare: async () => {}, answer: async question => {
      if (question === 'LEAK') { announce(); await pending; }
      return { ...answer, resolvedModel: 'claude-opus-5-5', retrievalTrace: { retrievalConfigVersion: 'fake', elapsedMs: 1, stages: {}, fallbackReason: 'selection-timeout' } };
    } },
    judge: async testcase => {
      if (testcase.id === 'QUOTA') { await started; setTimeout(release, 0); throw Object.assign(new Error('You have reached your specified API usage limits.'), { status: 400 }); }
      return { output, usage: answer.usage };
    } });
  expect(result.cases.map(row => row.status)).toEqual(['pass', 'judge-error', 'leak-failure', 'skipped']);
  expect(result.cases[2].judge).toBeUndefined();
  expect(summarize(result)).toMatchObject({ leakFailures: ['LEAK'], fallback: { count: 3, attempted: 3, frequency: 1 }, comparisonValid: false, passRate: null });
});


it('wide stage recall credits gold found only in always-supplied units', () => {
  const trace = { strategy: 'wide' as const, retrievalConfigVersion: 'fictional-wide', elapsedMs: 1, stages: {},
    search: { dense: [{ id: 'OTHER', score: 1 }], lexical: [], fused: [] },
    wide: { alwaysIds: ['C'], retrievedIds: ['OTHER'], droppedIds: [], evidenceBytes: 100, overviewPresent: true } };
  const result = grade(c, { ...answer, retrievedChunkIds: ['C', 'OTHER'], retrievalTrace: trace });
  expect(result.retrievalStages).toEqual({ dense: { k: 1, recallAtK: 0, firstGoldRank: null, selectedGoldSetIndex: 0 }, lexical: { k: 0, recallAtK: 0, firstGoldRank: null, selectedGoldSetIndex: 0 }, always: { k: 1, recallAtK: 1, firstGoldRank: 1, selectedGoldSetIndex: 1 }, supplied: { k: 2, recallAtK: 1, firstGoldRank: 1, selectedGoldSetIndex: 1 } });
});
it('wide loss attribution uses non-always rank and the best complete gold option with first ties', () => {
  const dense = Array.from({ length: 50 }, (_, i) => ({ id: `X${i + 1}`, score: 1 / (i + 1) }));
  const trace = { strategy: 'wide' as const, retrievalConfigVersion: 'fictional-wide', elapsedMs: 1, stages: {}, search: { dense: [{ id: 'ALWAYS', score: 2 }, ...dense], lexical: dense.slice(0, 24), fused: [] },
    wide: { alwaysIds: ['ALWAYS'], retrievedIds: ['X1'], droppedIds: ['X40'], evidenceBytes: 100, overviewPresent: true } };
  const supplied = { ...answer, retrievedChunkIds: ['ALWAYS', 'X1'], retrievalTrace: trace };
  const testcase = { ...c, goldChunks: [], goldChunkSets: [['ALWAYS', 'X40', 'X50'], ['X1', 'X41', 'X49']] };
  const result = grade(testcase, supplied);
  expect(result.retrievalStages?.supplied).toMatchObject({ recallAtK: 1 / 3, selectedGoldSetIndex: 0 });
  expect(result.retrievalLosses).toEqual({ 'pack-budget': ['X40'], 'not-retrieved': ['X50'] });
  expect(grade({ ...testcase, goldChunkSets: [['X50'], ['ALWAYS', 'X40']] }, supplied).retrievalLosses).toEqual({ 'pack-budget': ['X40'], 'not-retrieved': [] });
  expect(grade({ ...testcase, goldChunkSets: undefined, goldChunks: ['X40'] }, supplied).retrievalLosses).toEqual({ 'pack-budget': ['X40'], 'not-retrieved': [] });
});
