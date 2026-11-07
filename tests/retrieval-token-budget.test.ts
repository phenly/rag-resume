import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { createGenerationTokenBudget, createRetrievalTokenBudgets, TokenBudgetError, type VerifiedProviderCounter } from '../lib/retrieval/token-budget';
import { VOYAGE_MODEL } from '../lib/retrieval/voyage';
import { JEV_MODEL } from '../lib/retrieval/jev';

type CountMethod = Anthropic['beta']['messages']['countTokens'];
const fixtureCounter = (model: string): VerifiedProviderCounter => ({ model, revision: 'fictional-test-tokenizer-v1', verificationSource: 'synthetic fixture, not provider verification', count: vi.fn(async () => 17) });
const generation = (count = vi.fn(async () => ({ input_tokens: 23 }))) => ({ count, budget: createGenerationTokenBudget({ model: 'fictional-generator', countTokens: count as unknown as CountMethod }) });
const signal = () => new AbortController().signal;

describe('retrieval provider token-budget capabilities', () => {
  it('fails closed without provider counters and makes missing capabilities explicit', async () => {
    const budget = createRetrievalTokenBudgets();
    expect(budget.readiness.query).toEqual({ configured: false, model: VOYAGE_MODEL, reason: 'verified-counter-missing' });
    expect(budget.readiness.jev).toEqual({ configured: false, model: JEV_MODEL, reason: 'verified-counter-missing' });
    await expect(budget.query('fictional', {})).rejects.toMatchObject({ code: 'unavailable' });
    await expect(budget.jev('{}')).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('passes exact query serialization and signal to the pinned injected counter', async () => {
    const counter = fixtureCounter(VOYAGE_MODEL);
    const budget = createRetrievalTokenBudgets({ voyage: counter });
    const text = JSON.stringify({ currentQuestion: 'fictional café?', conversationContextNewestFirst: [] });
    const requestSignal = signal();
    expect(await budget.query(text, { signal: requestSignal })).toBe(17);
    expect(counter.count).toHaveBeenCalledWith(text, requestSignal);
    expect(budget.readiness.query).toMatchObject({ configured: true, verification: 'caller-supplied', revision: counter.revision });
  });

  it('passes complete serialized Jev request unchanged and snapshots supplied configuration', async () => {
    const counter = fixtureCounter(JEV_MODEL);
    const original = counter.count;
    const budget = createRetrievalTokenBudgets({ jev: counter });
    counter.count = async () => 999;
    counter.revision = 'changed';
    expect(await budget.jev('{"state":"fictional","questions":{}}')).toBe(17);
    expect(original).toHaveBeenCalledWith('{"state":"fictional","questions":{}}', undefined);
    expect(budget.readiness.jev).toMatchObject({ revision: 'fictional-test-tokenizer-v1' });
  });

  it.each([
    { model: 'other', revision: 'v1', verificationSource: 'fixture' },
    { model: VOYAGE_MODEL, revision: '', verificationSource: 'fixture' },
    { model: VOYAGE_MODEL, revision: 'v1', verificationSource: ' ' },
  ])('rejects incompatible or incomplete counter claims %#', metadata => {
    expect(() => createRetrievalTokenBudgets({ voyage: { ...metadata, count: async () => 1 } })).toThrow(TokenBudgetError);
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid provider token count %s', async tokens => {
    const counter = fixtureCounter(VOYAGE_MODEL);
    counter.count = async () => tokens;
    await expect(createRetrievalTokenBudgets({ voyage: counter }).query('fictional', {})).rejects.toMatchObject({ code: 'count' });
  });

  it('sanitizes provider errors', async () => {
    const counter = fixtureCounter(JEV_MODEL);
    counter.count = async () => { throw new Error('secret visitor text'); };
    await expect(createRetrievalTokenBudgets({ jev: counter }).jev('fictional')).rejects.toEqual(new TokenBudgetError('count'));
  });

  it('cancels an uncooperative pending counter', async () => {
    const controller = new AbortController();
    const counter = fixtureCounter(VOYAGE_MODEL);
    counter.count = () => new Promise(() => {});
    const result = createRetrievalTokenBudgets({ voyage: counter }).query('fictional', { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('does not invoke a provider for a previously aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    const counter = fixtureCounter(VOYAGE_MODEL);
    await expect(createRetrievalTokenBudgets({ voyage: counter }).query('fictional', { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(counter.count).not.toHaveBeenCalled();
  });
});

describe('generation token-budget adapter', () => {
  it('counts exact evidence rendering with probe/framing overhead retained and disables retries', async () => {
    const { count, budget } = generation();
    const text = '<document id="FICTION-1">\n# Café\nFactual text.\nRule: use care.\n</document>';
    const requestSignal = signal();
    expect(await budget.countEvidence(text, { signal: requestSignal })).toBe(23);
    expect(count).toHaveBeenCalledOnce();
    expect(count).toHaveBeenCalledWith({ model: 'fictional-generator', system: [{ type: 'text', text }], messages: [{ role: 'user', content: '.' }] }, { signal: requestSignal, maxRetries: 0 });
  });

  it('counts complete generation payload in chronological order and snapshots before awaiting', async () => {
    const { count, budget } = generation();
    const input = { system: [{ type: 'text' as const, text: 'fictional policies', cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }], question: 'follow-up', history: [{ question: 'old question', answer: 'old answer' }] };
    const result = budget.countRequest(input);
    input.system[0].text = 'changed'; input.history[0].answer = 'changed'; input.question = 'changed';
    expect(await result).toBe(23);
    expect(count).toHaveBeenCalledWith({ model: 'fictional-generator', system: [{ type: 'text', text: 'fictional policies', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'follow-up' }] }, { signal: undefined, maxRetries: 0 });
  });

  it('omits empty system and permits zero counts', async () => {
    const { count, budget } = generation(vi.fn(async () => ({ input_tokens: 0 })));
    expect(await budget.countRequest({ system: [], question: 'fictional' })).toBe(0);
    expect(count).toHaveBeenCalledWith({ model: 'fictional-generator', messages: [{ role: 'user', content: 'fictional' }] }, { signal: undefined, maxRetries: 0 });
  });

  it('rejects invalid counts and sanitizes failed API calls', async () => {
    const count = vi.fn(async () => ({ input_tokens: -1 }));
    const budget = generation(count).budget;
    await expect(budget.countEvidence('fictional', { signal: signal() })).rejects.toEqual(new TokenBudgetError('count'));
    count.mockRejectedValueOnce(new Error('secret provider body'));
    await expect(budget.countEvidence('fictional', { signal: signal() })).rejects.toEqual(new TokenBudgetError('count'));
  });

  it('cancels even if the injected SDK method ignores AbortSignal', async () => {
    const controller = new AbortController();
    const budget = createGenerationTokenBudget({ model: 'fictional', countTokens: (() => new Promise(() => {})) as unknown as CountMethod });
    const result = budget.countEvidence('fictional', { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects blank questions before calling the API', async () => {
    const { count, budget } = generation();
    await expect(budget.countRequest({ system: [], question: ' ' })).rejects.toMatchObject({ code: 'input' });
    expect(count).not.toHaveBeenCalled();
  });
});
