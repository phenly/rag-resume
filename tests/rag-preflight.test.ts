import { expect, it, vi } from 'vitest';
import * as prompt from '../lib/prompt';
import { preflightResolution } from '../scripts/rag-preflight';
import { corpusFixture } from './fixtures/corpus';
import { loadCorpus } from '../lib/corpus';
it('unavailable records kind and trace without whole prompt construction or counting', async () => {
  const corpus = await loadCorpus((await corpusFixture()).dir); const whole = vi.spyOn(prompt, 'buildSystemPrompt'); const createGuard = vi.fn();
  const trace = { retrievalConfigVersion: 'fictional', elapsedMs: 0, stages: {} };
  try {
    expect(await preflightResolution({ id: 'F1', question: 'lantern?' }, { kind: 'unavailable', reason: 'index-missing', trace }, corpus, createGuard))
      .toEqual({ id: 'F1', kind: 'unavailable', trace, eligibility: null, countMs: null });
    expect(whole).not.toHaveBeenCalled(); expect(createGuard).not.toHaveBeenCalled();
  } finally { whole.mockRestore(); }
});
