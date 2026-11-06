import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoyageEmbedder, VoyageEmbeddingError, VOYAGE_DIMENSIONS, VOYAGE_EMBEDDING_CONFIG, VOYAGE_MODEL } from '../lib/retrieval/voyage';

const vector = (value = 1) => Array<number>(VOYAGE_DIMENSIONS).fill(value);
const payload = () => ({ model: VOYAGE_MODEL, data: [{ index: 0, embedding: vector() }], usage: { total_tokens: 12 } });
const fetchFor = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
const make = (fetch: typeof globalThis.fetch, timeoutMs?: number) => createVoyageEmbedder({ apiKey: 'fictional-key', fetch, timeoutMs });
afterEach(() => vi.useRealTimers());

describe('Voyage embeddings boundary', () => {
  it.each(['document', 'query'] as const)('pins explicit nontruncating %s request and reports exact usage', async inputType => {
    const fetch = fetchFor(payload());
    const result = await make(fetch).embed(['Fictional widgets.'], inputType);
    expect(result).toEqual({ vectors: [vector()], model: VOYAGE_MODEL, dimensions: VOYAGE_DIMENSIONS, inputTokens: 12 });
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(options?.headers).toEqual({ Authorization: 'Bearer fictional-key', 'Content-Type': 'application/json' });
    expect(options?.redirect).toBe('error');
    expect(JSON.parse(options!.body as string)).toEqual({ input: ['Fictional widgets.'], model: VOYAGE_MODEL, input_type: inputType, truncation: false, output_dimension: 1024, output_dtype: 'float', encoding_format: null });
    expect(VOYAGE_EMBEDDING_CONFIG.normalization).toBe('l2');
  });

  it('restores original input order from explicit indexes', async () => {
    const body = payload();
    body.data = [{ index: 1, embedding: vector(2) }, { index: 0, embedding: vector(1) }];
    expect((await make(fetchFor(body)).embed(['One', 'Two'], 'document')).vectors).toEqual([vector(1), vector(2)]);
  });

  it('accepts omitted model metadata but rejects conflicting model metadata', async () => {
    const body: Record<string, unknown> = payload();
    delete body.model;
    await expect(make(fetchFor(body)).embed(['One'], 'document')).resolves.toMatchObject({ model: VOYAGE_MODEL });
    body.model = 'other-model';
    await expect(make(fetchFor(body)).embed(['One'], 'document')).rejects.toMatchObject({ code: 'response' });
  });

  it.each([
    ['count', { ...payload(), data: [] }],
    ['duplicate index', { ...payload(), data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] }],
    ['negative index', { ...payload(), data: [{ index: -1, embedding: vector() }] }],
    ['fractional index', { ...payload(), data: [{ index: 0.5, embedding: vector() }] }],
    ['out of bounds', { ...payload(), data: [{ index: 1, embedding: vector() }] }],
    ['dimensions', { ...payload(), data: [{ index: 0, embedding: [1] }] }],
    ['zero norm', { ...payload(), data: [{ index: 0, embedding: vector(0) }] }],
    ['string component', { ...payload(), data: [{ index: 0, embedding: [...vector().slice(1), '1'] }] }],
    ['missing usage', { ...payload(), usage: undefined }],
    ['negative usage', { ...payload(), usage: { total_tokens: -1 } }],
    ['fractional usage', { ...payload(), usage: { total_tokens: 0.5 } }],
    ['unsafe usage', { ...payload(), usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 } }],
  ])('rejects malformed %s', async (_, body) => {
    await expect(make(fetchFor(body)).embed(['One'], 'document')).rejects.toMatchObject({ code: 'response' });
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite vectors (%s)', async component => {
    const body = payload();
    body.data[0].embedding[0] = component;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({ ok: true, json: async () => body } as Response);
    await expect(make(fetch).embed(['One'], 'document')).rejects.toMatchObject({ code: 'response' });
  });

  it('rejects repeated indexes even with the expected vector count', async () => {
    const body = { ...payload(), data: [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }] };
    await expect(make(fetchFor(body)).embed(['One', 'Two'], 'document')).rejects.toMatchObject({ code: 'response' });
  });

  it.each([[], [''], ['  '], Array<string>(1), Array(1001).fill('One')])('rejects invalid input without a request', async texts => {
    const fetch = fetchFor(payload());
    await expect(make(fetch).embed(texts, 'document')).rejects.toMatchObject({ code: 'input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid credentials and timeout configuration', () => {
    for (const apiKey of ['', ' ', 'bad\nkey']) expect(() => createVoyageEmbedder({ apiKey })).toThrow(VoyageEmbeddingError);
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) expect(() => createVoyageEmbedder({ apiKey: 'fictional', timeoutMs })).toThrow(VoyageEmbeddingError);
  });

  it('never exposes provider error bodies or retries failed calls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('fictional-key and private source', { status: 429 }));
    await expect(make(fetch).embed(['private source'], 'query')).rejects.toMatchObject({ code: 'http', status: 429, message: 'Voyage embedding http (HTTP 429)' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('sanitizes transport and JSON errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('fictional-key private source'));
    await expect(make(fetch).embed(['One'], 'document')).rejects.toMatchObject({ code: 'network', message: 'Voyage embedding network' });
    await expect(make(fetchFor('not a response object')).embed(['One'], 'document')).rejects.toMatchObject({ code: 'response' });
    const malformed = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private source'));
    await expect(make(malformed).embed(['One'], 'document')).rejects.toMatchObject({ code: 'response', message: 'Voyage embedding response' });
  });

  it('avoids requests for already cancelled calls', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = fetchFor(payload());
    await expect(make(fetch).embed(['One'], 'query', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels in-flight calls and aborts the transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = make(fetch).embed(['One'], 'query', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort();
    await assertion;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('bounds response-body reading as well as the initial fetch', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as Response);
    const pending = make(fetch, 25).embed(['One'], 'document');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
