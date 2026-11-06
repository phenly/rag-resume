import { describe, expect, it, vi } from 'vitest';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants';
import config from '../next.config';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';

describe('production build freshness guard', () => {
  it('requires a matching local corpus/index even when approach remains whole', async () => {
    const f = await retrievalCorpusFixture();
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('CORPUS_DIR', f.dir);
    try {
      expect(() => config(PHASE_PRODUCTION_BUILD)).not.toThrow();
      await f.put(f.dir, f.manifest.positioningNotes, 'Changed source, old index');
      expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow('fresh validated');
      // Starting dev remains available while an offline index is being prepared.
      expect(() => config(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
});
