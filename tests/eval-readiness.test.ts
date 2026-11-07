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
