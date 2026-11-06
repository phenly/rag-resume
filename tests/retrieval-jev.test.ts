import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient, JEV_CONTEXT_LIMITS, JEV_MODEL, JevError } from '../lib/retrieval/jev';

const questions = [{ id: 'candidate:a', question: 'Is this passage relevant?', context: 'A fictional widget project.' }];
const payload = () => ({ model: JEV_MODEL, answers: { 'candidate:a': { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 120, output_tokens: 12 } });
const fetchFor = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
const counter = async () => 100;
const make = (fetch: typeof globalThis.fetch, timeoutMs?: number, countTokens: (text: string, signal?: AbortSignal) => Promise<number> = counter) => createJevClient({ apiKey: 'fictional-key', fetch, timeoutMs, countTokens });
afterEach(() => vi.useRealTimers());

describe('pinned direct Jev boundary', () => {
  it('pins model, separates data from rubric and returns ordered probabilities with billing', async () => {
    const fetch = fetchFor(payload());
    expect(await make(fetch).judge(questions)).toEqual({ model: JEV_MODEL, judgments: [{ id: 'candidate:a', probability: 0.7 }], inputTokens: 120, outputTokens: 12, costUsd: 120 * 0.042 / 1_000_000 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options?.redirect).toBe('error');
    expect(options?.headers).toEqual({ Authorization: 'Bearer fictional-key', 'Content-Type': 'application/json' });
    const body = JSON.parse(options!.body as string);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.questions['candidate:a']).toEqual({ type: 'noul', instructions: { fixedRubric: questions[0].question, untrustedData: { context: questions[0].context } } });
    expect(JSON.stringify(body.state)).not.toContain(questions[0].context);
  });

  it('includes shared context once in state and accounts for it in every context bound', async () => {
    const body = { model: JEV_MODEL, answers: { a: { type: 'noul', noul: 1 }, b: { type: 'noul', noul: 0 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    const fetch = fetchFor(body);
    const countTokens = vi.fn(async (text: string) => text.length);
    const sharedContext = 'Fictional question and fixed source rules.';
    await make(fetch, undefined, countTokens).judge([{ ...questions[0], id: 'a' }, { ...questions[0], id: 'b' }], { sharedContext });
    const serialized = fetch.mock.calls[0][1]?.body as string;
    expect(serialized.split(sharedContext)).toHaveLength(2);
    expect(JSON.parse(serialized).state.untrustedData.context).toBe(sharedContext);
    expect(countTokens).toHaveBeenCalledTimes(3);
    for (const [text] of countTokens.mock.calls) expect(JSON.parse(text).state.untrustedData.context).toBe(sharedContext);
  });

  it('rejects invalid shared context before counting or fetching', async () => {
    const fetch = fetchFor(payload()); const countTokens = vi.fn(counter);
    await expect(make(fetch, undefined, countTokens).judge(questions, { sharedContext: 12 as never })).rejects.toMatchObject({ code: 'input' });
    expect(fetch).not.toHaveBeenCalled(); expect(countTokens).not.toHaveBeenCalled();
  });

  it('preserves request order and permits zero/one probability and zero usage', async () => {
    const body = { model: JEV_MODEL, answers: { b: { type: 'noul', noul: 1 }, a: { type: 'noul', noul: 0 } }, usage: { input_tokens: 0, output_tokens: 0 } };
    expect((await make(fetchFor(body)).judge([{ ...questions[0], id: 'a' }, { ...questions[0], id: 'b' }])).judgments).toEqual([{ id: 'a', probability: 0 }, { id: 'b', probability: 1 }]);
  });

  it.each([
    ['model alias', { ...payload(), model: 'jev-latest' }],
    ['model mismatch', { ...payload(), model: 'jev-1.14.0' }],
    ['model absent', { ...payload(), model: undefined }],
    ['missing answer', { ...payload(), answers: {} }],
    ['unexpected answer', { ...payload(), answers: { other: { type: 'noul', noul: 0.5 } } }],
    ['extra answer', { ...payload(), answers: { ...payload().answers, other: { type: 'noul', noul: 0.5 } } }],
    ['wrong type', { ...payload(), answers: { 'candidate:a': { type: 'score', noul: 0.5 } } }],
    ['missing probability', { ...payload(), answers: { 'candidate:a': { type: 'noul' } } }],
    ['low probability', { ...payload(), answers: { 'candidate:a': { type: 'noul', noul: -0.01 } } }],
    ['high probability', { ...payload(), answers: { 'candidate:a': { type: 'noul', noul: 1.01 } } }],
    ['string probability', { ...payload(), answers: { 'candidate:a': { type: 'noul', noul: '0.5' } } }],
    ['null probability', { ...payload(), answers: { 'candidate:a': { type: 'noul', noul: null } } }],
    ['missing usage', { ...payload(), usage: undefined }],
    ['negative usage', { ...payload(), usage: { input_tokens: -1, output_tokens: 0 } }],
    ['fractional usage', { ...payload(), usage: { input_tokens: 0, output_tokens: 0.5 } }],
    ['unsafe usage', { ...payload(), usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 } }],
  ])('rejects malformed %s', async (_, body) => {
    await expect(make(fetchFor(body)).judge(questions)).rejects.toMatchObject({ code: 'response' });
  });

  it.each([
    '{"model":"jev-1.13.0","answers":{"candidate:a":{"type":"noul","noul":0.7},"candidate:a":{"type":"noul","noul":0.8}},"usage":{"input_tokens":0,"output_tokens":0}}',
    '{"model":"jev-1.13.0","answers":{"candidate:a":{"type":"noul","noul":0.7,"noul":0.8}},"usage":{"input_tokens":0,"output_tokens":0}}',
    '{"model":"jev-1.13.0","answers":{"candidate:a":{"type":"noul","noul":0.7},"candidate:\\u0061":{"type":"noul","noul":0.8}},"usage":{"input_tokens":0,"output_tokens":0}}',
    '{"model":"jev-1.13.0","answers":{"candidate:a":{"type":"noul","noul":1e999}},"usage":{"input_tokens":0,"output_tokens":0}}',
    'malformed fictional response',
  ])('rejects duplicate keys, nonfinite numbers and invalid JSON', async text => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(text));
    await expect(make(fetch).judge(questions)).rejects.toMatchObject({ code: 'response' });
  });

  it('handles nested unknown metadata without losing duplicate-key validation', async () => {
    const body = { ...payload(), extra: [{ a: 'escaped " text', nested: [true, null, 12] }] };
    await expect(make(fetchFor(body)).judge(questions)).resolves.toMatchObject({ model: JEV_MODEL });
  });

  it.each([[], Array(1), [{ ...questions[0], id: '' }], [{ ...questions[0], question: ' ' }], [{ ...questions[0], context: null }], [questions[0], questions[0]]])('rejects invalid input without requests', async input => {
    const fetch = fetchFor(payload());
    await expect(make(fetch).judge(input as typeof questions)).rejects.toMatchObject({ code: 'input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid client configuration', () => {
    for (const apiKey of ['', ' ', 'fictional\nkey']) expect(() => createJevClient({ apiKey, countTokens: counter })).toThrow(JevError);
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) expect(() => createJevClient({ apiKey: 'fictional', countTokens: counter, timeoutMs })).toThrow(JevError);
    expect(() => createJevClient({ apiKey: 'fictional', countTokens: undefined as never })).toThrow(JevError);
  });

  it('checks complete serialized request and each complete question against separate limits', async () => {
    const fetch = fetchFor(payload());
    const countTokens = vi.fn().mockResolvedValueOnce(JEV_CONTEXT_LIMITS.request).mockResolvedValueOnce(JEV_CONTEXT_LIMITS.question);
    await make(fetch, undefined, countTokens).judge(questions);
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(JSON.parse(countTokens.mock.calls[0][0]).questions['candidate:a']).toBeDefined();
    expect(JSON.parse(countTokens.mock.calls[1][0]).state).toBeDefined();
  });

  it.each(['request', 'question'] as const)('fails closed on %s budget overflow without truncation or fetch', async level => {
    const fetch = fetchFor(payload());
    const countTokens = vi.fn().mockResolvedValueOnce(level === 'request' ? 64001 : 100).mockResolvedValueOnce(32001);
    await expect(make(fetch, undefined, countTokens).judge(questions)).rejects.toMatchObject({ code: 'budget' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid counter result %s', async value => {
    const fetch = fetchFor(payload());
    await expect(make(fetch, undefined, async () => value).judge(questions)).rejects.toMatchObject({ code: 'count' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes counter, network, JSON and status failures without retry', async () => {
    const fetch = fetchFor(payload());
    await expect(make(fetch, undefined, async () => { throw new Error('fictional-private'); }).judge(questions)).rejects.toMatchObject({ code: 'count', message: 'Jev count' });
    expect(fetch).not.toHaveBeenCalled();
    const failing = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('fictional-key private context'));
    await expect(make(failing).judge(questions)).rejects.toMatchObject({ code: 'network', message: 'Jev network' });
    for (const status of [401, 429, 500, 503]) {
      const errorFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('fictional-key private context', { status }));
      await expect(make(errorFetch).judge(questions)).rejects.toMatchObject({ code: 'http', status, message: `Jev http (HTTP ${status})` });
      expect(errorFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('owns its snapshot while counting asynchronously', async () => {
    let release!: (tokens: number) => void;
    const countTokens = vi.fn().mockImplementationOnce(() => new Promise<number>(resolve => { release = resolve; })).mockResolvedValue(100);
    const fetch = fetchFor(payload());
    const input = questions.map(item => ({ ...item }));
    const pending = make(fetch, undefined, countTokens).judge(input);
    input[0].id = 'mutated'; input[0].context = 'mutated';
    release(100);
    await expect(pending).resolves.toMatchObject({ judgments: [{ id: 'candidate:a' }] });
    expect(fetch.mock.calls[0][1]?.body).not.toContain('mutated');
  });

  it('rejects pre-cancelled calls before counting or fetch', async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = fetchFor(payload()); const countTokens = vi.fn(counter);
    await expect(make(fetch, undefined, countTokens).judge(questions, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled(); expect(countTokens).not.toHaveBeenCalled();
  });

  it('cancels stalled counting and never starts fetch afterward', async () => {
    let release!: (tokens: number) => void;
    const countTokens = vi.fn((...args: [string, AbortSignal?]) => { void args; return new Promise<number>(resolve => { release = resolve; }); });
    const fetch = fetchFor(payload()); const controller = new AbortController();
    const pending = make(fetch, undefined, countTokens).judge(questions, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort(); await assertion; release(100);
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
    expect(countTokens.mock.calls[0][1]?.aborted).toBe(true);
  });

  it.each(['count', 'fetch', 'body'] as const)('deadline covers stalled %s and aborts transport', async phase => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (phase === 'fetch') fetch.mockReturnValue(new Promise(() => {}));
    else fetch.mockResolvedValue({ ok: true, text: () => new Promise(() => {}) } as Response);
    const countTokens = phase === 'count' ? () => new Promise<number>(() => {}) : counter;
    const pending = make(fetch, 25, countTokens).judge(questions);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25); await assertion;
    if (phase === 'count') expect(fetch).not.toHaveBeenCalled();
    else expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
