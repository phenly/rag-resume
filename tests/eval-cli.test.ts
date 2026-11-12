import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';
import { requireFreshRetrievalIndex } from '../lib/retrieval/load';

const mocks = vi.hoisted(() => ({ runApproach: vi.fn(), ragApproach: vi.fn(), countCorpus: vi.fn(), countTokens: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { beta = { messages: { countTokens: mocks.countTokens } }; } }));
vi.mock('../lib/eval/runner', () => ({ runApproach: mocks.runApproach }));
vi.mock('../lib/eval/rag', () => ({ ragApproach: mocks.ragApproach }));
vi.mock('../lib/eval/corpus', async original => ({ ...await original<object>(), countCorpus: mocks.countCorpus }));
beforeEach(() => mocks.countCorpus.mockResolvedValue({ total: 100, parts: {}, note: 'Fictional offline count' }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('preserves an incomplete whole run and skips every RAG provider operation', async () => {
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  const caseFile = path.join(fixture.root, 'cases.json');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [{ id: 'EX1', category: 'grounded', status: 'decided', question: 'Widgets?', rubric: 'Use documented facts', goldChunks: [], mustSay: [], mustNotSay: [], source: 'fictional' }] }));
  mocks.runApproach.mockResolvedValue({ name: 'whole', status: 'incomplete', cases: [], indexFreshness: null, embeddingDollars: null });
  const { main } = await import('../scripts/eval');
  const out = path.join(fixture.root, 'results');
  await expect(main(['--cases', caseFile, '--out', out, '--approach', 'both', '--no-judge'])).rejects.toThrow('Evaluation incomplete');
  expect(mocks.runApproach).toHaveBeenCalledOnce();
  expect(mocks.ragApproach).not.toHaveBeenCalled();
  const destination = path.join(out, (await readdir(out, { withFileTypes: true })).find(entry => entry.isDirectory())!.name);
  const results = JSON.parse(await readFile(path.join(destination, 'results.json'), 'utf8'));
  expect(results.status).toBe('incomplete');
  expect(results.approaches).toHaveLength(1);
  expect(results.approaches[0].status).toBe('incomplete');
  expect(JSON.parse(await readFile(path.join(destination, 'completion.json'), 'utf8'))).toMatchObject({ status: 'incomplete', approachesSkipped: ['rag'] });
  expect(JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'))).toMatchObject({ gradingVersion: 'context-grounding-stage-recall-quota-2' });
  expect(await readFile(path.join(destination, 'run-error.json'), 'utf8')).toContain('Evaluation incomplete');
  expect(await readFile(path.join(destination, 'retrieval-index.json'), 'utf8')).toContain(fixture.index.indexVersion);
  expect((await requireFreshRetrievalIndex(path.join(destination, 'corpus'))).indexVersion).toBe(fixture.index.indexVersion);
});

it('stops at a corpus-count account quota and preserves an incomplete run without starting either approach', async () => {
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [] }));
  mocks.countCorpus.mockRejectedValueOnce(Object.assign(new Error('You have reached your specified API usage limits.'), { status: 400 }));
  const { main } = await import('../scripts/eval');
  const out = path.join(fixture.root, 'results');
  await expect(main(['--cases', path.join(fixture.root, 'cases.json'), '--out', out, '--approach', 'both', '--no-judge'])).rejects.toThrow('API usage limits');
  expect(mocks.runApproach).not.toHaveBeenCalled();
  expect(mocks.ragApproach).not.toHaveBeenCalled();
  const destination = path.join(out, (await readdir(out, { withFileTypes: true })).find(entry => entry.isDirectory())!.name);
  const results = JSON.parse(await readFile(path.join(destination, 'results.json'), 'utf8'));
  expect(results).toMatchObject({ status: 'incomplete', approaches: [], stopReason: expect.stringContaining('account-quota') });
  expect(JSON.parse(await readFile(path.join(destination, 'completion.json'), 'utf8'))).toMatchObject({ status: 'incomplete', approachesSkipped: ['whole', 'rag'] });
  expect(await readFile(path.join(destination, 'report.md'), 'utf8')).toContain('incomplete');
  expect((await requireFreshRetrievalIndex(path.join(destination, 'corpus'))).indexVersion).toBe(fixture.index.indexVersion);
});

it.each([
  ['whole', 'wide', '--strategy requires --approach rag or both'],
  ['rag', 'bogus', '--strategy must be jev or wide'],
])('rejects strategy %s/%s before loading inputs', async (approach, strategy, message) => {
  const { main } = await import('../scripts/eval');
  await expect(main(['--cases', '/fictional/missing.json', '--out', '/fictional/out', '--approach', approach, '--strategy', strategy])).rejects.toThrow(message);
});

it('documents --strategy in offline help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const { main } = await import('../scripts/eval');
    await main(['--help']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--strategy jev|wide'));
  } finally { log.mockRestore(); }
});

it.each([['rag', 'wide'], ['both', 'wide'], ['rag', 'jev']])('--strategy is accepted and records strategy/config receipts for %s/%s', async (approach, strategy) => {
  const { activeRetrievalConfigVersion } = await import('../lib/retrieval/production');
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [] }));
  mocks.runApproach.mockImplementation(async ({ approach }) => ({ name: approach?.name ?? 'rag', ...(approach?.strategy ? { strategy: approach.strategy } : {}), status: 'complete', cases: [], indexFreshness: null, embeddingDollars: 0 }));
  mocks.ragApproach.mockImplementation((_config, options) => ({ name: 'rag', strategy: options.strategy }));
  const { main } = await import('../scripts/eval');
  const out = path.join(fixture.root, 'results');
  await main(['--cases', path.join(fixture.root, 'cases.json'), '--out', out, '--approach', approach, '--strategy', strategy, '--no-judge']);
  expect(mocks.ragApproach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ strategy }));
  expect(mocks.countCorpus).toHaveBeenCalledTimes(approach === 'both' ? 1 : 0);
  expect(mocks.countTokens).not.toHaveBeenCalled();
  const destination = path.join(out, (await readdir(out, { withFileTypes: true })).find(entry => entry.isDirectory())!.name);
  for (const file of ['receipt.json', 'results.json']) expect(JSON.parse(await readFile(path.join(destination, file), 'utf8'))).toMatchObject({ strategy, retrievalConfigVersion: activeRetrievalConfigVersion(strategy as 'jev' | 'wide') });
  expect(JSON.parse((await readFile(path.join(out, 'runs.jsonl'), 'utf8')).trim())).toMatchObject({ strategy, retrievalConfigVersion: activeRetrievalConfigVersion(strategy as 'jev' | 'wide') });
});

it('defaults rag to the configured strategy and validates --only against just --cases', async () => {
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', 'wide');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [] }));
  mocks.runApproach.mockResolvedValue({ name: 'rag', strategy: 'wide', status: 'complete', cases: [], indexFreshness: null, embeddingDollars: 0 });
  const { main } = await import('../scripts/eval');
  const args = ['--cases', path.join(fixture.root, 'cases.json'), '--out', path.join(fixture.root, 'results'), '--approach', 'rag', '--no-judge'];
  await expect(main([...args, '--only', 'HELD-OUT'])).rejects.toThrow('Unknown case ID: HELD-OUT');
  expect(mocks.ragApproach).not.toHaveBeenCalled();
  await main(args);
  expect(mocks.ragApproach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ strategy: 'wide' }));
});

it.each([
  ['whole', 'wide', '--strategy requires --approach rag or both'],
  ['rag', 'bogus', '--strategy must be jev or wide'],
])('CLI exits nonzero for %s/%s', (approach, strategy, message) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval.ts', '--cases', '/fictional/missing.json', '--out', '/fictional/out', '--approach', approach, '--strategy', strategy], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
});

it('wide-only CLI answers a real offline case without corpus or Anthropic token counting', async () => {
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  vi.stubEnv('RAG_GENERATOR_CONTEXT_TOKENS', '1000000');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [{ id: 'WIDE', category: 'grounded', status: 'decided', question: 'Fictional widgets?', rubric: 'Use facts', goldChunks: [], mustSay: [], mustNotSay: [], source: 'fictional' }] }));
  const { runApproach } = await vi.importActual<typeof import('../lib/eval/runner')>('../lib/eval/runner');
  const { ragApproach } = await vi.importActual<typeof import('../lib/eval/rag')>('../lib/eval/rag');
  const stream = vi.fn(() => ({
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Fictional widget answer.' } }; },
    finalMessage: async () => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }), abort: vi.fn(),
  }));
  mocks.runApproach.mockImplementation(runApproach);
  mocks.ragApproach.mockImplementation((config, options) => ragApproach(config, { ...options,
    client: { beta: { messages: { stream, countTokens: mocks.countTokens } } },
    preparePipeline: async () => ({ resolve: async () => ({ kind: 'evidence', selected: [], always: [], trace: { strategy: 'wide', retrievalConfigVersion: 'fictional-wide', elapsedMs: 1, stages: {}, wide: { alwaysIds: [], retrievedIds: [], droppedIds: [], evidenceBytes: 0, overviewPresent: false } } }) }),
  }));
  const { main } = await import('../scripts/eval');
  const out = path.join(fixture.root, 'results');
  await main(['--cases', path.join(fixture.root, 'cases.json'), '--out', out, '--approach', 'rag', '--strategy', 'wide', '--no-judge']);
  expect(stream).toHaveBeenCalledOnce();
  expect(mocks.countCorpus).not.toHaveBeenCalled();
  expect(mocks.countTokens).not.toHaveBeenCalled();
  const destination = path.join(out, (await readdir(out, { withFileTypes: true })).find(entry => entry.isDirectory())!.name);
  expect(JSON.parse(await readFile(path.join(destination, 'results.json'), 'utf8')).approaches[0].cases[0].answer).toMatchObject({ effectiveApproach: 'rag', actualContext: 'wide-evidence' });
});

it.each(['whole', 'rag'])('keeps implicit strategy metadata absent for legacy %s receipts', async approach => {
  const fixture = await retrievalCorpusFixture();
  vi.stubEnv('CORPUS_DIR', fixture.dir);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fictional-key');
  vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', '');
  await fixture.put(fixture.root, 'cases.json', JSON.stringify({ version: 1, cases: [] }));
  mocks.runApproach.mockResolvedValue({ name: approach, status: 'complete', cases: [], indexFreshness: null, embeddingDollars: 0 });
  mocks.ragApproach.mockReturnValue({ name: 'rag' });
  const { main } = await import('../scripts/eval');
  const out = path.join(fixture.root, 'results');
  await main(['--cases', path.join(fixture.root, 'cases.json'), '--out', out, '--approach', approach, '--no-judge']);
  const destination = path.join(out, (await readdir(out, { withFileTypes: true })).find(entry => entry.isDirectory())!.name);
  const receipt = JSON.parse(await readFile(path.join(destination, 'receipt.json'), 'utf8'));
  expect(receipt).not.toHaveProperty('strategy');
  expect(receipt).not.toHaveProperty('retrievalConfigVersion');
  const results = JSON.parse(await readFile(path.join(destination, 'results.json'), 'utf8'));
  expect(results).not.toHaveProperty('strategy');
  expect(results.retrievalConfigVersion).toBe('738011460764090aa0079c77e14bf7d7158307482fd45cb69022d6fd90b8d758');
});
