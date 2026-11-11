import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { corpusFixture } from './fixtures/corpus';
import { loadCorpus } from '../lib/corpus';
import { signTurn } from '../lib/history';
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), guard: vi.fn(), generate: vi.fn(), prepare: vi.fn(), whole: vi.fn(), guardFactory: vi.fn() }));
vi.mock('../lib/retrieval/production', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/retrieval/production')>(),
  UNAVAILABLE_ANSWER: 'Temporarily unavailable.',
  prepareProductionRagPipeline: mocks.prepare, createWholeFallbackGuard: mocks.guardFactory,
}));
vi.mock('../lib/claude', async original => ({ ...await original<object>(), readAskConfig: () => ({ apiKey: 'fictional', model: 'fictional-model', effort: 'low', maxTokens: 1000 }), streamAnswer: mocks.generate }));
vi.mock('../lib/prompt', async original => { const actual = await original<typeof import('../lib/prompt')>(); return { ...actual, buildSystemPrompt: mocks.whole.mockImplementation(actual.buildSystemPrompt) }; });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('RAG_GENERATOR_CONTEXT_TOKENS', '20000'); vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', undefined);
  const f = await corpusFixture(); vi.stubEnv('CORPUS_DIR', f.dir); vi.stubEnv('CVAI_APPROACH', 'rag'); vi.stubEnv('HISTORY_SECRET', 'fictional-secret');
  mocks.prepare.mockResolvedValue({ ready: true, resolve: mocks.resolve });
  mocks.resolve.mockResolvedValue({ kind: 'fallback', reason: 'test', trace: {} });
  mocks.guardFactory.mockReturnValue(mocks.guard);
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
it('rejects visitor approach overrides before preparing providers', async () => {
  const { POST } = await import('../app/api/ask/route');
  expect((await POST(request({ question: 'widgets?', approach: 'whole' }))).status).toBe(400);
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});

it('unavailable never constructs the whole prompt or starts generation', async () => {
  mocks.resolve.mockResolvedValue({ kind: 'unavailable', reason: 'index-missing', trace: {} });
  const { POST } = await import('../app/api/ask/route'); const text = await (await POST(request({ question: 'lantern?' }))).text();
  expect(text).toContain('Temporarily unavailable.'); expect(text).toContain('"status":"incomplete"'); expect(text).not.toContain('"sig":');
  expect(mocks.whole).not.toHaveBeenCalled(); expect(mocks.guardFactory).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});


describe('wide strategy', () => {
  const unit = { id: 'FICTION-1', title: 'Lantern trial', document: 'Imaginary Studio', promptText: 'Built a fictional lantern.' };
  beforeEach(() => {
    vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', 'wide');
    mocks.resolve.mockResolvedValue({ kind: 'evidence', always: [{ ...unit, id: 'ALWAYS' }], selected: [unit], trace: {} });
  });
  it('generates from the wide prompt without counting tokens or building whole', async () => {
    const { POST } = await import('../app/api/ask/route');
    const text = await (await POST(request({ question: 'lantern?' }))).text();
    expect(mocks.generate).toHaveBeenCalledOnce();
    const system = mocks.generate.mock.calls[0][1];
    expect(system.at(-2).text).toMatch(/^# Career context supplied with every answer/);
    expect(system.at(-1).text).toContain(unit.promptText); expect(text).toContain('"sig":');
    expect(mocks.whole).not.toHaveBeenCalled(); expect(mocks.guardFactory).not.toHaveBeenCalled();
    expect(mocks.prepare.mock.calls[0][0].strategy).toBe('wide');
  });
  it.each(['preparation', 'resolve', 'unavailable', 'missing-limit', 'overflow', 'route', 'fallback', 'unexpected'])('fails closed unsigned for %s', async failure => {
    if (failure === 'preparation') mocks.prepare.mockRejectedValue(new Error('fictional failure'));
    if (failure === 'resolve') mocks.resolve.mockRejectedValue(new Error('fictional failure'));
    if (['unavailable', 'route', 'fallback', 'unexpected'].includes(failure)) mocks.resolve.mockResolvedValue({ kind: failure, answer: 'Must not serve', reason: 'fictional', trace: {} });
    if (failure === 'missing-limit') vi.stubEnv('RAG_GENERATOR_CONTEXT_TOKENS', undefined);
    if (failure === 'overflow') {
      vi.stubEnv('RAG_GENERATOR_CONTEXT_TOKENS', '3000');
      mocks.resolve.mockResolvedValue({ kind: 'evidence', always: [], selected: [{ ...unit, promptText: 'Fictional lantern. '.repeat(1000) }], trace: {} });
    }
    const { POST } = await import('../app/api/ask/route');
    const text = await (await POST(request({ question: 'lantern?' }))).text();
    expect(text.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ type: 'text', text: 'Temporarily unavailable.' }, { type: 'done', status: 'incomplete' }]);
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.guardFactory).not.toHaveBeenCalled(); expect(mocks.whole).not.toHaveBeenCalled();
  });
  it('reuses wide preparation when the TypeSafe key changes', async () => {
    const { POST } = await import('../app/api/ask/route');
    await (await POST(request({ question: 'lantern?' }))).text();
    vi.stubEnv('TYPESAFE_API_KEY', 'changed-fictional-key');
    await (await POST(request({ question: 'cloud?' }))).text();
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it('prepares a separate pipeline when the strategy changes', async () => {
    const { POST } = await import('../app/api/ask/route');
    await (await POST(request({ question: 'lantern?' }))).text();
    vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', undefined);
    await (await POST(request({ question: 'cloud?' }))).text();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.prepare.mock.calls.map(([options]) => options.strategy)).toEqual(['wide', 'jev']);
  });
  it('starts no providers for a disconnected request', async () => {
    const { POST } = await import('../app/api/ask/route');
    expect(await (await POST(request({ question: 'lantern?' }, AbortSignal.abort()))).text()).toBe('');
    expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
  });
  it('returns no events for cancelled retrieval', async () => {
    mocks.resolve.mockResolvedValue({ kind: 'cancelled', trace: {} });
    const { POST } = await import('../app/api/ask/route');
    expect(await (await POST(request({ question: 'lantern?' }))).text()).toBe('');
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.whole).not.toHaveBeenCalled();
  });
});
it('jev still falls back to the whole prompt with the strategy unset', async () => {
  const { POST } = await import('../app/api/ask/route');
  const text = await (await POST(request({ question: 'widgets?' }))).text();
  expect(mocks.whole).toHaveBeenCalledOnce(); expect(mocks.guardFactory).toHaveBeenCalledOnce(); expect(text).toContain('"sig":');
});

it('whole remains the default even when wide is configured', async () => {
  vi.stubEnv('CVAI_APPROACH', undefined); vi.stubEnv('CVAI_RETRIEVAL_STRATEGY', 'wide');
  const { POST } = await import('../app/api/ask/route');
  const text = await (await POST(request({ question: 'widgets?' }))).text();
  expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.whole).toHaveBeenCalledOnce();
  expect(mocks.generate).toHaveBeenCalledOnce(); expect(text).toContain('"sig":');
});
