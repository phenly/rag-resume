import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as files from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import golden from './fixtures/voyage-tokenizer-golden.json';
import { createVoyageQueryTokenCounter, VOYAGE_TOKENIZER } from '../lib/retrieval/voyage-tokenizer';
import { createRetrievalTokenBudgets } from '../lib/retrieval/token-budget';
import { buildRetrievalQuery } from '../lib/retrieval/query';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const directory = path.join(process.cwd(), 'assets', 'tokenizers', 'voyage-4-large');
const tokenizer = new Tokenizer(JSON.parse(readFileSync(path.join(directory, 'tokenizer.json'), 'utf8')),
  JSON.parse(readFileSync(path.join(directory, 'tokenizer_config.json'), 'utf8')));

afterEach(() => vi.restoreAllMocks());

describe('pinned Voyage query tokenizer', () => {
  it('matches canonical Rust token IDs for all raw and prefix-inclusive fictional fixtures', () => {
    expect(golden.revision).toBe(VOYAGE_TOKENIZER.revision);
    for (const fixture of golden.fixtures) {
      expect(tokenizer.encode(fixture.text, { add_special_tokens: true }).ids).toEqual(fixture.ids);
      expect(tokenizer.encode(VOYAGE_TOKENIZER.queryPrefix + fixture.text, { add_special_tokens: true }).ids).toEqual(fixture.queryIds);
    }
  });

  it('counts the complete prefixed query locally, with immutable provenance and no network', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const counter = await createVoyageQueryTokenCounter();
    expect(Object.isFrozen(counter)).toBe(true);
    expect(counter.revision).toContain(VOYAGE_TOKENIZER.revision);
    expect(counter.revision).toContain(VOYAGE_TOKENIZER.tokenizerSha256);
    expect(counter.revision).toContain(VOYAGE_TOKENIZER.runtime);
    for (const fixture of golden.fixtures) expect(await counter.count(fixture.text)).toBe(fixture.queryIds.length);
    expect(network).not.toHaveBeenCalled();
  });

  it('composes with the production budget adapter and includes the prefix in the question limit', async () => {
    const counter = await createVoyageQueryTokenCounter();
    const budgets = createRetrievalTokenBudgets({ voyage: counter });
    expect(budgets.readiness.query.configured).toBe(true);
    const text = 'Hello world.';
    const tokens = await counter.count(text);
    expect(tokens).toBeGreaterThan(tokenizer.encode(text).ids.length);
    expect(await buildRetrievalQuery({ question: text, countTokens: budgets.query, maxTokens: tokens - 1 }))
      .toEqual({ ok: false, reason: 'question-over-budget' });
    const result = await buildRetrievalQuery({ question: text, countTokens: budgets.query, maxTokens: tokens });
    expect(result.ok && result.inputTokens).toBe(tokens);
  });

  it('does not truncate long input or pad short input', async () => {
    const counter = await createVoyageQueryTokenCounter();
    const text = ' world'.repeat(33_000);
    expect(await counter.count(text)).toBe(tokenizer.encode(VOYAGE_TOKENIZER.queryPrefix + text).ids.length);
    expect(await counter.count(text)).toBeGreaterThan(32_768);
    expect(await counter.count('x')).toBeLessThan(100);
  });

  it('fails closed on cancellation, non-text and malformed UTF-16 without leaking input', async () => {
    const counter = await createVoyageQueryTokenCounter();
    const controller = new AbortController(); controller.abort();
    await expect(counter.count('private fictional input', controller.signal)).rejects.toMatchObject({ code: 'cancelled', message: 'Token budget cancelled' });
    for (const input of [null, 42, '\ud800', '\udc00', 'x\ud800x', '\ud800\ud800\udc00', '\ud800\udc00\udc00']) {
      await expect(counter.count(input as string)).rejects.toMatchObject({ code: 'input', message: 'Token budget input' });
    }
    await expect(counter.count('😀')).resolves.toBeGreaterThan(0);
  });

  it('rejects a corrupted tokenizer artifact', async () => {
    vi.resetModules();
    vi.mocked(files.readFile).mockResolvedValueOnce(Buffer.from('{}')).mockResolvedValueOnce(Buffer.from('{}'));
    const fresh = await import('../lib/retrieval/voyage-tokenizer');
    await expect(fresh.createVoyageQueryTokenCounter()).rejects.toMatchObject({ code: 'unavailable', message: 'Token budget unavailable' });
  });

  it('rejects missing packaged artifacts without disclosing filesystem errors', async () => {
    vi.resetModules();
    vi.mocked(files.readFile).mockRejectedValueOnce(new Error('secret path must not leak')).mockRejectedValueOnce(new Error('secret path must not leak'));
    const fresh = await import('../lib/retrieval/voyage-tokenizer');
    await expect(fresh.createVoyageQueryTokenCounter()).rejects.toMatchObject({ code: 'unavailable', message: 'Token budget unavailable' });
  });
});
