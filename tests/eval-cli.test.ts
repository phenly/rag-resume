import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';
import { requireFreshRetrievalIndex } from '../lib/retrieval/load';

const mocks = vi.hoisted(() => ({ runApproach: vi.fn(), ragApproach: vi.fn(), countCorpus: vi.fn() }));
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
