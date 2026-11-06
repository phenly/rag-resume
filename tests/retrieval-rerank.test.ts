import { describe, expect, it, vi } from 'vitest';
import { rerankEvidence, RERANK_CONFIG, type EvidenceCandidate } from '../lib/retrieval/rerank';
import { createJevClient, type JevClient, type JevQuestion } from '../lib/retrieval/jev';

const candidate = (id: string, score = 1): EvidenceCandidate => ({ unit: { id, kind: 'entry', document: 'FictionalCo', title: 'Scope', searchText: 'Managed widgets.', promptText: `${id}: Managed widgets.\nRule: retain this rule.`, indexedHash: 'a'.repeat(64), promptHash: 'b'.repeat(64) }, match: { id, score } });
function setup(candidates = [candidate('EX-A')], overrides: Record<string, number> = {}) {
  const judge = vi.fn(async (questions: readonly JevQuestion[], _options?: { signal?: AbortSignal; sharedContext?: string }) => { void _options; return ({ model: 'jev-1.13.0' as const,
    judgments: questions.map(({ id }) => ({ id, probability: overrides[id] ?? (id === 'route_answer' || id.startsWith('candidate_') || id === 'adequacy' ? 1 : 0) })),
    inputTokens: 100, outputTokens: 10, costUsd: 0.001 }); });
  return { question: 'What did the subject build?', context: 'Earlier question/answer.', alwaysMaterial: 'Only use sourced facts.', candidates, judge: { judge } satisfies JevClient,
    renderEvidence: (units: readonly EvidenceCandidate['unit'][]) => JSON.stringify(units.map(unit => unit.promptText)), countEvidenceTokens: vi.fn(async (_text: string) => { void _text; return 100; }) };
}

describe('Jev selection and complete evidence packing', () => {
  it('uses two checks, complete rules, and request-local usage receipts', async () => {
    const options = setup();
    const result = await rerankEvidence(options);
    expect(result).toMatchObject({ kind: 'evidence', tokens: 100, selected: [options.candidates[0].unit], trace: { adequacy: 1, configVersion: RERANK_CONFIG.version, calls: [{ inputTokens: 100 }, { inputTokens: 100 }] } });
    expect(options.judge.judge).toHaveBeenCalledTimes(2);
    const first = options.judge.judge.mock.calls[0][0];
    expect(first[0].context).toContain('retain this rule');
    expect(first[0].question).not.toContain(options.question);
    expect(JSON.parse(options.judge.judge.mock.calls[0][1]!.sharedContext!)).toMatchObject({ question: options.question, conversationContext: options.context });
    expect(first[0].context).not.toContain(options.alwaysMaterial);
  });
  it('composes with the REST adapter while sharing policies once across 24 candidates', async () => {
    const options = setup(Array.from({ length: 24 }, (_, i) => candidate(`EX-${i}`)));
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      void _url;
      const body = JSON.parse(init!.body as string);
      expect(body.state.untrustedData.context).toContain(options.alwaysMaterial);
      expect((init!.body as string).split(options.alwaysMaterial)).toHaveLength(2);
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id.startsWith('candidate_') || id === 'route_answer' || id === 'adequacy' ? 1 : 0 }])), usage: { input_tokens: 100, output_tokens: 0 } }));
    });
    const judge = createJevClient({ apiKey: 'fictional-key', countTokens: async () => 100, fetch: transport as typeof fetch });
    const result = await rerankEvidence({ ...options, judge });
    expect(result.kind).toBe('evidence');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.trace.decisions.filter(item => item.reason === 'selected')).toHaveLength(8);
    expect(result.trace.relevance).toHaveLength(24);
  });
  it('sorts relevance then fused score then stable ID, includes threshold equality', async () => {
    const options = setup([candidate('EX-B'), candidate('EX-C', 2), candidate('EX-A')], { candidate_0: .35, candidate_1: .35, candidate_2: .35, adequacy: .70 });
    const result = await rerankEvidence(options);
    expect(result.kind).toBe('evidence');
    if (result.kind === 'evidence') expect(result.selected.map(unit => unit.id)).toEqual(['EX-C', 'EX-A', 'EX-B']);
  });
  it('attributes relevance, top-eight, and token-budget exclusions separately', async () => {
    const options = setup(Array.from({ length: 11 }, (_, i) => candidate(`EX-${String(i).padStart(2, '0')}`, 20 - i)), { candidate_10: .349 });
    options.countEvidenceTokens.mockImplementation(async text => text.includes('EX-01') ? 6001 : 100);
    const result = await rerankEvidence(options);
    // An individually oversized relevant entry must fail, rather than lose its rules.
    expect(result).toMatchObject({ kind: 'fallback', reason: 'oversize-entry' });
    options.countEvidenceTokens.mockImplementation(async text => text.includes('EX-01') && text.includes('EX-00') ? 6001 : 100);
    const packed = await rerankEvidence(options);
    expect(packed.kind).toBe('evidence');
    expect(packed.trace.decisions.filter(item => item.reason === 'selected')).toHaveLength(8);
    expect(packed.trace.decisions).toContainEqual(expect.objectContaining({ id: 'EX-01', reason: 'token-budget' }));
    expect(packed.trace.decisions).toContainEqual(expect.objectContaining({ id: 'EX-09', reason: 'top-eight' }));
    expect(packed.trace.decisions).toContainEqual(expect.objectContaining({ id: 'EX-10', reason: 'relevance' }));
  });
  it.each(['redirect', 'decline'] as const)('requires .90 confidence for %s and makes no adequacy call', async route => {
    const options = setup([], { route_answer: 0, [`route_${route}`]: .90 });
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'route', route });
    expect(options.judge.judge).toHaveBeenCalledTimes(1);
    const low = setup([], { route_answer: 0, [`route_${route}`]: .899 });
    expect(await rerankEvidence(low)).toMatchObject({ kind: 'fallback', reason: 'uncertain-route' });
  });
  it('falls back for tied/uncertain routing, empty evidence, and inadequate evidence', async () => {
    expect(await rerankEvidence(setup([], { route_uncertain: 1 }))).toMatchObject({ kind: 'fallback', reason: 'uncertain-route' });
    expect(await rerankEvidence(setup())).toMatchObject({ kind: 'evidence' });
    expect(await rerankEvidence(setup([]))).toMatchObject({ kind: 'fallback', reason: 'empty-evidence' });
    expect(await rerankEvidence(setup(undefined, { adequacy: .699 }))).toMatchObject({ kind: 'fallback', reason: 'inadequate-evidence' });
  });
  it.each(['missing', 'extra', 'duplicate', 'nonfinite', 'model', 'usage'])('fails closed on %s judgments even from injected clients', async variant => {
    const options = setup();
    const good = await options.judge.judge([{ id: 'candidate_0', question: '', context: '' }, ...['answer', 'redirect', 'decline', 'uncertain'].map(route => ({ id: `route_${route}`, question: '', context: '' }))]);
    if (variant === 'missing') good.judgments.pop();
    if (variant === 'extra') good.judgments.push({ id: 'alien', probability: 1 });
    if (variant === 'duplicate') good.judgments[1] = good.judgments[0];
    if (variant === 'nonfinite') good.judgments[0].probability = NaN;
    if (variant === 'model') Object.assign(good, { model: 'jev-new' });
    if (variant === 'usage') good.inputTokens = -1;
    options.judge.judge.mockResolvedValue(good);
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'fallback', reason: 'judgment' });
  });
  it('rejects conflicting high-confidence independent dispositions', async () => {
    expect(await rerankEvidence(setup(undefined, { route_answer: .99, route_redirect: .98 }))).toMatchObject({ kind: 'fallback', reason: 'uncertain-route' });
  });
  it('falls back on a low-probability answer disposition and retains relevance receipts', async () => {
    const result = await rerankEvidence(setup(undefined, { route_answer: .01 }));
    expect(result).toMatchObject({ kind: 'fallback', reason: 'uncertain-route', trace: { relevance: [{ id: 'EX-A', probability: 1 }] } });
  });
  it('handles token-counter failures and exactly 6000 evidence tokens', async () => {
    const options = setup();
    options.countEvidenceTokens.mockResolvedValue(6000);
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'evidence', tokens: 6000 });
    options.countEvidenceTokens.mockResolvedValue(NaN);
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'fallback', reason: 'token-counter' });
  });
  it('rejects duplicate and mismatched candidate IDs before judgment', async () => {
    const malformed = setup([null as unknown as EvidenceCandidate]);
    expect(await rerankEvidence(malformed)).toMatchObject({ kind: 'fallback', reason: 'invalid-input' });
    const options = setup([candidate('EX-A'), candidate('EX-A')]);
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'fallback', reason: 'invalid-input' });
    expect(options.judge.judge).not.toHaveBeenCalled();
    options.candidates[1].unit.id = 'EX-B';
    expect(await rerankEvidence(options)).toMatchObject({ kind: 'fallback', reason: 'invalid-input' });
  });
  it('bounds the entire two-call phase even when a dependency ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const options = setup();
      options.judge.judge.mockImplementation(() => new Promise(() => {}));
      const pending = rerankEvidence(options);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await pending).toMatchObject({ kind: 'fallback', reason: 'timeout', trace: { calls: [{ status: 'usage-unknown' }] } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('propagates client cancellation and starts no second judgment', async () => {
    const options = setup();
    options.judge.judge.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = rerankEvidence({ ...options, signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ kind: 'fallback', reason: 'cancelled' });
    expect(options.judge.judge).toHaveBeenCalledTimes(1);
  });
});
