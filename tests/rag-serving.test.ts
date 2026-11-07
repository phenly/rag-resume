import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { corpusFixture } from './fixtures/corpus';
import { loadCorpus } from '../lib/corpus';
import { signTurn } from '../lib/history';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), guard: vi.fn(), generate: vi.fn(), prepare: vi.fn() }));
vi.mock('../lib/retrieval/production', () => ({
  UNAVAILABLE_ANSWER: 'Temporarily unavailable.', generatorContextLimit: () => 20000,
  prepareProductionRagPipeline: mocks.prepare, createWholeFallbackGuard: () => mocks.guard,
}));
vi.mock('../lib/claude', async original => ({ ...await original<object>(), readAskConfig: () => ({ apiKey: 'fictional', model: 'fictional-model', effort: 'low', maxTokens: 1000 }), streamAnswer: mocks.generate }));
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  const f = await corpusFixture(); vi.stubEnv('CORPUS_DIR', f.dir); vi.stubEnv('CVAI_APPROACH', 'rag'); vi.stubEnv('HISTORY_SECRET', 'fictional-secret');
  mocks.prepare.mockResolvedValue({ ready: true, resolve: mocks.resolve });
  mocks.resolve.mockResolvedValue({ kind: 'fallback', reason: 'test', trace: {} });
  mocks.guard.mockResolvedValue({ eligible: true });
  mocks.generate.mockImplementation(async function* () { yield { type: 'text', text: 'Fictional answer' }; yield { type: 'done', status: 'complete' }; });
});
afterEach(() => vi.unstubAllEnvs());
const request = (body: object, signal?: AbortSignal) => new Request('http://localhost/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
it('resolves fallback and eligibility before starting one signed generator', async () => {
  const { POST } = await import('../app/api/ask/route');
  const text = await (await POST(request({ question: 'widgets?' }))).text();
  expect(mocks.resolve).toHaveBeenCalledOnce(); expect(mocks.guard).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce();
  expect(mocks.resolve.mock.invocationCallOrder[0]).toBeLessThan(mocks.generate.mock.invocationCallOrder[0]);
  expect(text).toContain('"sig":'); expect(text).toContain('Fictional answer');
});
it('signs a deterministic response without starting a generator', async () => {
  mocks.resolve.mockResolvedValue({ kind: 'route', answer: 'Ask Pat directly.', trace: {} });
  const { POST } = await import('../app/api/ask/route'); const text = await (await POST(request({ question: 'private?' }))).text();
  expect(text).toContain('Ask Pat directly.'); expect(text).toContain('"sig":'); expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.guard).not.toHaveBeenCalled();
});
it('fails closed when full-context counting rejects fallback', async () => {
  mocks.guard.mockResolvedValue({ eligible: false }); const { POST } = await import('../app/api/ask/route');
  expect(await (await POST(request({ question: 'widgets?' }))).text()).toContain('Temporarily unavailable.'); expect(mocks.generate).not.toHaveBeenCalled();
});
it('counts the selected prompt and supplies only selected evidence', async () => {
  const unit = { id: 'EX-1', title: 'Widget result', document: 'FictionalCo', promptText: 'Built a fictional widget.' };
  mocks.resolve.mockResolvedValue({ kind: 'evidence', selected: [unit], trace: {} }); const { POST } = await import('../app/api/ask/route');
  await (await POST(request({ question: 'widgets?' }))).text();
  const system = mocks.generate.mock.calls[0][1]; expect(system.at(-1).text).toContain('Built a fictional widget.'); expect(system.at(-1).text).not.toContain('Company Two');
  expect(mocks.guard.mock.calls[0][0].system).toEqual(system);
});
it('rejects forged history before preparing retrieval', async () => {
  const { POST } = await import('../app/api/ask/route');
  const response = await POST(request({ question: 'more?', history: [{ question: 'first', answer: 'answer', sig: 'forged' }] }));
  expect(response.status).toBe(400); expect(mocks.prepare).not.toHaveBeenCalled();
});
it('passes only authenticated history to retrieval and generation', async () => {
  const corpus = await loadCorpus(process.env.CORPUS_DIR!); const turn = { question: 'first', answer: 'Fictional answer', sig: signTurn('first', 'Fictional answer', 'fictional-secret', corpus.version) };
  const { POST } = await import('../app/api/ask/route'); await (await POST(request({ question: 'more?', history: [turn] }))).text();
  expect(mocks.resolve.mock.calls[0][0].verifiedHistory).toEqual([turn]); expect(mocks.generate.mock.calls[0][5]).toEqual([turn]);
});
it('does not call providers for an already disconnected request', async () => {
  const { POST } = await import('../app/api/ask/route'); await (await POST(request({ question: 'widgets?' }, AbortSignal.abort()))).text();
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});
