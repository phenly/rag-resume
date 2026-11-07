import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus } from '../lib/corpus';
import { buildSystemPrompt, publicProfileText, PROMPT_TEMPLATE_VERSION } from '../lib/prompt';
import { readCases, validateCases } from '../lib/eval/cases';
import { grade, runApproach } from '../lib/eval/runner';
import { dollars } from '../lib/eval/pricing';
import { createJudge } from '../lib/eval/judge';
import { summarize, report, writeRun, type Run } from '../lib/eval/report';
import { countCorpus, chunkIndex } from '../lib/eval/corpus';
import { retry } from '../lib/eval/retry';
import { wholeApproach } from '../lib/eval/whole';
import { corpusFixture } from './fixtures/corpus';
import type { Answer, EvalCase, JudgeOutput } from '../lib/eval/types';
const c: EvalCase = { id: 'G1', category: 'grounded', status: 'decided', question: 'A fictional question?', rubric: 'Grounded answer', mustSay: ['hello'], mustNotSay: ['secret'], goldChunks: ['EX-1', 'EX-2'], source: 'fictional' };
const answer: Answer = { text: 'Hello world', usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }, timings: { firstTokenMs: 10, totalMs: 100 } };
const judge: JudgeOutput = { rubricMet: true, reason: 'Supported', unsupportedClaims: [], leaked: false, usedChunkIds: ['EX-2'] };
const corpus = () => loadCorpus(path.resolve('sample-corpus'));
const fakeClient = (value: unknown) => value as Anthropic;

describe('eval case schema', () => {
  it('loads the fictional sample', async () => { expect((await readCases('eval/sample-cases.json')).cases).toHaveLength(5); });
  it.each([
    [null, 'expected'], [{ version: 2, cases: [] }, 'version'], [{ version: 1, cases: [{ ...c, status: 'maybe' }] }, 'status'],
    [{ version: 1, cases: [{ ...c, category: 'other' }] }, 'category'], [{ version: 1, cases: [{ ...c, mustSay: ['['] }] }, 'regex'],
    [{ version: 1, cases: [c, c] }, 'duplicate'], [{ version: 1, cases: [{ ...c, goldChunks: 'bad' }] }, 'goldChunks'],
    [{ version: 1, cases: [{ ...c, rubric: '' }] }, 'rubric'],
  ])('rejects bad schema with a clear message', (value, message) => { expect(() => validateCases(value)).toThrow(message); });
});
it('grades every regex case-insensitively and records patterns', () => {
  expect(grade(c, answer, judge).status).toBe('pass');
  expect(grade({ ...c, mustSay: ['hello', 'missing'], mustNotSay: ['WORLD', 'secret'] }, answer, judge)).toMatchObject({ status: 'fail', checks: { mustSayMisses: ['missing'], mustNotSayHits: ['WORLD'] } });
  expect(grade(c, answer, { ...judge, rubricMet: false }).status).toBe('fail');
});
it('retrieval records recall, 1-based first gold rank, unused chunks and rerank drops', () => {
  expect(grade(c, { ...answer, retrievedChunkIds: ['OTHER', 'EX-2', 'EX-2'], droppedByRerank: ['DROP'] }, judge).retrieval).toEqual({ k: 2, recallAtK: 0.5, firstGoldRank: 2, retrievedButUnused: 1, droppedByRerank: ['DROP'] });
  expect(grade({ ...c, goldChunks: [] }, { ...answer, retrievedChunkIds: [] }).retrieval).toMatchObject({ recallAtK: null, firstGoldRank: null });
  expect(grade(c, answer, judge).retrieval).toBeUndefined();
});
describe('alternative retrieval evidence sets', () => {
  const alternatives: EvalCase = { ...c, goldChunks: [], goldChunkSets: [['EX-1', 'EX-2'], ['ALT-1', 'ALT-2']] };
  it('accepts alternatives without changing legacy schemas', () => {
    expect(validateCases({ version: 1, cases: [alternatives] }).cases[0]).toEqual(alternatives);
    expect(validateCases({ version: 1, cases: [c] }).cases[0]).toEqual(c);
  });
  it.each([null, [], ['EX-1'], [[]], [['']], [['   ']], [[' EX-1']], [['EX-1', 'EX-1']], [[1]]])('rejects malformed alternatives: %j', goldChunkSets => {
    expect(() => validateCases({ version: 1, cases: [{ ...alternatives, goldChunkSets }] })).toThrow('goldChunkSets');
  });
  it('rejects ambiguous legacy gold with alternatives', () => {
    expect(() => validateCases({ version: 1, cases: [{ ...c, goldChunkSets: [['ALT-1']] }] })).toThrow('goldChunks must be empty');
  });
  it('selects a complete alternate without requiring the union', () => {
    expect(grade(alternatives, { ...answer, retrievedChunkIds: ['OTHER', 'ALT-1', 'ALT-2'] }).retrieval).toMatchObject({ k: 3, recallAtK: 1, firstGoldRank: 2, selectedGoldSetIndex: 1 });
  });
  it('keeps partial alternatives partial and selects the first declaration on ties', () => {
    expect(grade(alternatives, { ...answer, retrievedChunkIds: ['ALT-1', 'EX-2'] }).retrieval).toMatchObject({ recallAtK: 0.5, firstGoldRank: 2, selectedGoldSetIndex: 0 });
    expect(grade(alternatives, { ...answer, retrievedChunkIds: [] }).retrieval).toMatchObject({ recallAtK: 0, firstGoldRank: null, selectedGoldSetIndex: 0 });
  });
  it('deduplicates hits, ranks and unused counts while preserving the raw rerank trace', () => {
    expect(grade(alternatives, { ...answer, retrievedChunkIds: ['OTHER', 'OTHER', 'ALT-1', 'ALT-1'], droppedByRerank: ['EX-2', 'ALT-2'] }, judge).retrieval).toEqual({ k: 2, recallAtK: 0.5, firstGoldRank: 2, selectedGoldSetIndex: 1, retrievedButUnused: 2, droppedByRerank: ['EX-2', 'ALT-2'] });
  });
  it('does not invent retrieval metrics for whole-corpus answers', () => {
    expect(grade(alternatives, answer).retrieval).toBeUndefined();
    expect(grade({ ...c, goldChunks: [] }, { ...answer, retrievedChunkIds: ['OTHER'] }).retrieval).toMatchObject({ recallAtK: null, firstGoldRank: null });
  });
});
it('prices uncached, write, read and output separately', () => {
  expect(dollars('claude-opus-5-5', answer.usage)).toBeCloseTo((400 + 1600 + 60 + 1000) / 1e6);
  expect(dollars('claude-sonnet-5-5', answer.usage)).toBeCloseTo((300 + 1200 + 90 + 750) / 1e6);
  expect(dollars('unknown', answer.usage)).toBeNull();
});
it('excludes open and leak-probe cases, separates leaks and cold/warm speed', async () => {
  const answers = [answer, { ...answer, usage: { ...answer.usage, cache_creation_input_tokens: 0 }, timings: { firstTokenMs: 20, totalMs: 60 } }, answer, { ...answer, text: 'secret' }];
  const a = await runApproach({ approach: { name: 'whole', prepare: vi.fn(), answer: vi.fn(async () => answers.shift()!) }, corpus: await corpus(), cases: [c, { ...c, id: 'G2' }, { ...c, id: 'O', status: 'open' }, { ...c, id: 'L', category: 'leak-probe' }], concurrency: 1, model: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5-5', judge: async () => ({ output: judge, usage: answer.usage }) });
  const s = summarize(a);
  expect(s).toMatchObject({ eligible: 2, passing: 2, passRate: 1, leakFailures: ['L'], speeds: { cold: { count: 3, totalMs: 100 }, warm: { count: 1, totalMs: 60 } } });
  expect(s.cacheHitRate).toBeCloseTo(1200 / 2200);
  expect(grade({ ...c, category: 'leak-probe' }, answer, { ...judge, leaked: true }).status).toBe('leak-failure');
  expect(grade({ ...c, category: 'leak-probe' }, { ...answer, text: 'secret' }).status).toBe('leak-failure');
});
it('completes the first question before concurrent work and preserves ordering', async () => {
  let active = 0; let max = 0; let firstFinished = false;
  const a = await runApproach({ approach: { name: 'whole', prepare: vi.fn(), async answer(q) {
    if (q !== 'first') expect(firstFinished).toBe(true);
    active++; max = Math.max(max, active);
    await new Promise(r => setTimeout(r, 5));
    if (q === 'first') firstFinished = true;
    active--; return answer;
  } }, corpus: await corpus(), cases: ['first', 'second', 'third', 'fourth'].map((question, i) => ({ ...c, id: String(i), question })), concurrency: 3, model: '', judgeModel: '' });
  expect(max).toBe(3); expect(a.cases.map(r => r.case.id)).toEqual(['0', '1', '2', '3']);
  expect(summarize(a).passRate).toBeNull();
});
it('forces judge tool and caching; malformed judge output becomes judge-error with usage cost', async () => {
  const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ rubricMet: true }) }], usage: answer.usage });
  const j = createJudge(fakeClient({ messages: { create } }), 'claude-sonnet-5-5', 'Fictional career');
  const a = await runApproach({ approach: { name: 'whole', prepare: vi.fn(), answer: async () => answer }, corpus: await corpus(), cases: [c], concurrency: 1, model: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5-5', judge: j });
  expect(a.cases[0]).toMatchObject({ status: 'judge-error', judgeUsage: answer.usage });
  expect(a.cases[0].judgeDollars).toBeGreaterThan(0);
  expect(create.mock.calls[0][0]).toMatchObject({ output_config: { format: { type: 'json_schema' } }, system: [{}, { cache_control: { ttl: '1h' } }] });
  create.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(judge) }], usage: answer.usage });
  expect(await j(c, 'Hello')).toEqual({ output: judge, usage: answer.usage });
});
it('records per-case answer errors and continues', async () => {
  const a = await runApproach({ approach: { name: 'whole', prepare: vi.fn(), answer: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(answer) }, corpus: await corpus(), cases: [c, { ...c, id: 'G2' }], concurrency: 1, model: '', judgeModel: '' });
  expect(a.cases.map(r => r.status)).toEqual(['answer-error', 'unjudged']);
});
it('counts the exact live prompt and independent parts via the mocked SDK', async () => {
  // Baseline probe (no system) counts 3; every system count returns 126, so each part nets 123.
  const countTokens = vi.fn(async (req: { system?: unknown }) => ({ input_tokens: req.system ? 126 : 3 }));
  const cp = await corpus();
  const counts = await countCorpus(fakeClient({ beta: { messages: { countTokens } } }), 'claude-opus-5-5', cp);
  expect(countTokens.mock.calls[0][0]).toEqual({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '.' }] });
  expect(countTokens.mock.calls[1][0]).toEqual({ model: 'claude-opus-5-5', system: buildSystemPrompt(cp), messages: [{ role: 'user', content: '.' }] });
  expect(counts).toMatchObject({ promptTemplateVersion: PROMPT_TEMPLATE_VERSION, total: 123, parts: { careerChunks: 123, profile: 123, globalRules: 0 } });
  const index = await chunkIndex(path.resolve('sample-corpus'), cp);
  expect(index.text).toContain(publicProfileText(cp.profile));
  expect(index.ids).toContain('QFS-ROUTE-01'); expect(new Set(index.ids).size).toBe(index.ids.length);
});
it('retries at most twice, only for transient errors', async () => {
  const call = vi.fn().mockRejectedValue({ status: 429 }); const pause = vi.fn();
  await expect(retry(call, pause)).rejects.toEqual({ status: 429 }); expect(call).toHaveBeenCalledTimes(3);
  call.mockReset().mockRejectedValue({ status: 400 });
  await expect(retry(call, pause)).rejects.toEqual({ status: 400 }); expect(call).toHaveBeenCalledTimes(1);
  call.mockReset().mockRejectedValueOnce({ status: 503 }).mockRejectedValueOnce({ message: 'overloaded' }).mockResolvedValue('ok');
  expect(await retry(call, pause)).toBe('ok');
});
it('reads export chunk IDs and exposes their titles to the judge', async () => {
  const f = await corpusFixture();
  await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks: [{ id: 'EX-ONE', title: 'Company One', hash: 'fictional' }] }));
  const cp = await loadCorpus(f.dir);
  expect(await chunkIndex(f.dir, cp)).toMatchObject({ ids: ['EX-ONE'], text: expect.stringContaining('EX-ONE: Company One') });
  await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks: { 'EX-TWO': { title: 'Company Two', hash: 'fictional' } } }));
  expect((await chunkIndex(f.dir, cp)).ids).toEqual(['EX-TWO']);
});
it('gives the judge response-style context separately from career facts', async () => {
  const cp = await corpus();
  cp.answerStyle = 'For weakness questions, use a playful joke before a documented lesson.';
  const index = await chunkIndex(path.resolve('sample-corpus'), cp);
  expect(index.text).toContain('# Answer style and response behavior (guidance, not career facts)\n' + cp.answerStyle);
  expect(index.text.indexOf(cp.answerStyle)).toBeGreaterThan(index.text.indexOf('# Positioning notes and handling rules'));
});
it('whole adapter streams through the existing implementation with per-question usage', async () => {
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }; },
    finalMessage: async () => ({ stop_reason: 'end_turn', usage: answer.usage }), abort: vi.fn(),
  }));
  const a = wholeApproach({ apiKey: 'fictional', model: 'claude-opus-5-5', effort: 'medium', maxTokens: 1000 }, fakeClient({ beta: { messages: { stream } } }));
  await a.prepare(await corpus());
  const r = await a.answer('Verbatim?');
  expect(r.text).toBe('Hello'); expect(r.usage).toEqual(answer.usage); expect(r.timings.firstTokenMs).toBeGreaterThanOrEqual(0);
  expect(stream.mock.calls[0]).toBeDefined();
});
it('reports rag as not built and writes JSON, markdown, and append-only trends', async () => {
  const a = await runApproach({ corpus: await corpus(), cases: [c], concurrency: 1, model: '', judgeModel: '' });
  expect(a).toMatchObject({ name: 'rag', status: 'not built', cases: [] });
  const run: Run = { version: 1, startedAt: '2026-11-03T12:34:56.000Z', answerModel: 'claude-opus-5-5', judgeModel: null, corpus: { version: '1234567890', chunkCount: 2 }, approaches: [a] };
  expect(report(run)).toContain('rag — not built');
  expect(report(run)).toContain('Prompt template: historical/unrecorded.');
  run.promptTemplateVersion = PROMPT_TEMPLATE_VERSION;
  run.retrievalConfigVersion = 'a'.repeat(64);
  expect(report(run)).toContain(`Prompt template: ${PROMPT_TEMPLATE_VERSION}.`);
  const out = await mkdtemp(path.join(os.tmpdir(), 'eval-test-'));
  try {
    const dir = await writeRun(out, run); const second = await writeRun(out, run);
    expect(path.basename(dir)).toBe('2026-11-03T1234-12345678'); expect(second).not.toBe(dir);
    const saved = JSON.parse(await readFile(path.join(dir, 'results.json'), 'utf8'));
    expect(saved.approaches[0].status).toBe('not built');
    expect(saved.promptTemplateVersion).toBe(PROMPT_TEMPLATE_VERSION);
    expect(saved.retrievalConfigVersion).toBe(run.retrievalConfigVersion);
    const trends = (await readFile(path.join(out, 'runs.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(trends.every(row => row.promptTemplateVersion === PROMPT_TEMPLATE_VERSION && row.retrievalConfigVersion === run.retrievalConfigVersion)).toBe(true);
    expect((await readFile(path.join(out, 'runs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally { await rm(out, { recursive: true, force: true }); }
});
it('keeps SDK stream usage isolated when concurrent answers finish together', async () => {
  let sequence = 0;
  const stream = vi.fn(() => {
    const input = ++sequence;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: `Answer ${input}` } }; },
      finalMessage: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: input, output_tokens: 10 } }), abort: vi.fn(),
    };
  });
  const a = wholeApproach({ apiKey: 'fictional', model: 'claude-opus-5-5', effort: 'medium', maxTokens: 1000 }, fakeClient({ beta: { messages: { stream } } }));
  await a.prepare(await corpus());
  const answers = await Promise.all(['one', 'two', 'three'].map(q => a.answer(q)));
  expect(answers.map(r => r.usage.input_tokens)).toEqual([1, 2, 3]);
});

it.each(['grounded', 'adversarial', 'leak-probe'] as const)('fails judge-detected leaks in %s cases', category => {
  expect(grade({ ...c, category }, answer, { ...judge, leaked: true }).status).toBe('leak-failure');
});
it('fails conflicting judge fields when unsupported claims are present', () => {
  expect(grade(c, answer, { ...judge, unsupportedClaims: ['Fictional fabricated claim'] }).status).toBe('fail');
});
it('passes positioning evidence and handling rules to the judge separately from source facts', async () => {
  const cp = { ...await corpus(), positioningNotes: 'Withhold the fictional violet project. Fictional role: navigator.', globalRules: 'Do not quote internal notes.' };
  const index = await chunkIndex(path.resolve('sample-corpus'), cp);
  const create = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(judge) }], usage: answer.usage });
  await createJudge(fakeClient({ messages: { create } }), 'claude-sonnet-5-5', index.text)(c, answer.text);
  const system = create.mock.calls[0][0].system;
  expect(system[1].text).toContain('# Source facts\n');
  expect(system[1].text).toContain(`# Positioning notes and handling rules\n${cp.positioningNotes}`);
  expect(system[1].text).toContain(`# Source rules\n${cp.globalRules}`);
  expect(system[0].text).toContain('positioning notes');
});
it.each([408, 409, new Anthropic.APIConnectionError({}), new Anthropic.APIConnectionTimeoutError({})])('retries transient SDK failures up to three attempts: %s', async error => {
  const failure = typeof error === 'number' ? { status: error } : error;
  const call = vi.fn().mockRejectedValue(failure);
  await expect(retry(call, vi.fn())).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(3);
});
it('uses eligible answer and judge spend per pass and reports all-case operational spend separately', () => {
  const rows = [
    { case: c, status: 'pass' as const, answerDollars: 2, judgeDollars: 3 },
    { case: { ...c, id: 'F' }, status: 'fail' as const, answerDollars: 4, judgeDollars: 5 },
    { case: { ...c, id: 'O', status: 'open' as const }, status: 'pass' as const, answerDollars: 100, judgeDollars: 200 },
    { case: { ...c, id: 'L', category: 'leak-probe' as const }, status: 'pass' as const, answerDollars: 300, judgeDollars: 400 },
  ];
  const approach = { name: 'whole', status: 'complete' as const, cases: rows, indexFreshness: null, embeddingDollars: 0 };
  expect(summarize(approach)).toMatchObject({ dollarsPerPassingAnswer: 14, totalDollars: 1014 });
  expect(summarize({ ...approach, cases: rows.slice(0, 2) }).dollarsPerPassingAnswer).toBe(14);
});
it('notes when every question was warm and no cold timing was measured', () => {
  const warm = { ...answer, usage: { ...answer.usage, cache_creation_input_tokens: 0 } };
  const run: Run = { version: 1, startedAt: '2026-11-03', answerModel: 'fictional', judgeModel: null, corpus: { version: 'fictional', chunkCount: 1 }, approaches: [{ name: 'whole', status: 'complete', cases: [{ case: c, status: 'unjudged', answer: warm }], indexFreshness: null, embeddingDollars: 0 }] };
  expect(report(run)).toContain('No cache-write response was observed; no cold-cache timing was measured.');
  run.approaches[0].cases[0].answer = answer;
  expect(report(run)).not.toContain('No cache-write response was observed');
});

const evalModels = { model: 'claude-opus-5-5', judgeModel: 'claude-sonnet-5-5' };
const streamConfig = { apiKey: 'fictional', model: evalModels.model, effort: 'medium' as const, maxTokens: 1500 };
it('retains max_tokens answer usage and timings instead of reporting zero spend', async () => {
  const usage = { input_tokens: 100, output_tokens: 1500 };
  const stream = () => ({
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fictional partial answer' } }; },
    finalMessage: async () => ({ stop_reason: 'max_tokens', usage }), abort: vi.fn(),
  });
  const a = await runApproach({ approach: wholeApproach(streamConfig, fakeClient({ beta: { messages: { stream } } })), corpus: await corpus(), cases: [c], concurrency: 1, ...evalModels });
  expect(a.cases[0]).toMatchObject({ status: 'answer-error', answerUsage: usage, answerTimings: { firstTokenMs: expect.any(Number), totalMs: expect.any(Number) }, answerDollars: dollars(evalModels.model, usage) });
  expect(summarize(a)).toMatchObject({ totalDollars: dollars(evalModels.model, usage), costIncomplete: false });
});
it('marks unknown answer and judge spend incomplete while retaining known spend', async () => {
  const options = { corpus: await corpus(), cases: [c], concurrency: 1, ...evalModels };
  const failedAnswer = await runApproach({ ...options, approach: { name: 'whole', prepare: vi.fn(), answer: async () => { throw new Error('offline'); } } });
  expect(summarize(failedAnswer)).toMatchObject({ totalDollars: null, costIncomplete: true, dollarsPerPassingAnswer: null });
  const failedJudge = await runApproach({ ...options, approach: { name: 'whole', prepare: vi.fn(), answer: async () => answer }, judge: async () => { throw new Error('offline judge'); } });
  expect(summarize(failedJudge)).toMatchObject({ totalDollars: null, costIncomplete: true, knownDollars: dollars(evalModels.model, answer.usage) });
});
it('accumulates partial streaming retry usage and flags unavailable final usage', async () => {
  let attempt = 0;
  const partial = { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 20 };
  const stream = () => {
    const first = attempt++ === 0;
    return {
      async *[Symbol.asyncIterator]() {
        if (first) {
          yield { type: 'message_start', message: { usage: { ...partial, output_tokens: 0 } } };
          yield { type: 'message_delta', usage: { output_tokens: 7 } };
          throw Object.assign(new Error('fictional overload'), { status: 503 });
        }
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      },
      finalMessage: async () => ({ stop_reason: 'end_turn', usage: answer.usage }), abort: vi.fn(),
    };
  };
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const a = await runApproach({ approach: wholeApproach(streamConfig, fakeClient({ beta: { messages: { stream } } })), corpus: await corpus(), cases: [c], concurrency: 1, ...evalModels });
    expect(attempt).toBe(2);
    expect(a.cases[0].answer?.usage).toEqual({ input_tokens: 110, output_tokens: 57, cache_creation_input_tokens: 200, cache_read_input_tokens: 320 });
    expect(summarize(a)).toMatchObject({ totalDollars: null, costIncomplete: true, knownDollars: dollars(evalModels.model, { input_tokens: 110, output_tokens: 57, cache_creation_input_tokens: 200, cache_read_input_tokens: 320 }) });
  } finally { log.mockRestore(); }
});
it('keeps judge retry usage and marks missing retry usage incomplete', async () => {
  const create = vi.fn().mockRejectedValueOnce({ status: 503, usage: { input_tokens: 10, output_tokens: 2 } }).mockRejectedValueOnce({ status: 503 }).mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(judge) }], usage: answer.usage });
  const a = await runApproach({ approach: { name: 'whole', prepare: vi.fn(), answer: async () => answer }, corpus: await corpus(), cases: [c], concurrency: 1, ...evalModels, judge: createJudge(fakeClient({ messages: { create } }), evalModels.judgeModel, 'Fictional source') });
  expect(a.cases[0].judgeUsage).toEqual({ input_tokens: 110, output_tokens: 52, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 });
  expect(summarize(a)).toMatchObject({ totalDollars: null, costIncomplete: true, dollarsPerPassingAnswer: null });
});
