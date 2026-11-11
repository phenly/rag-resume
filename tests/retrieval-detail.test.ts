import { describe, expect, it } from 'vitest';
import { retrievalDetail } from '../lib/retrieval/detail';
import { RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';
import { WIDE_CONFIG_VERSION } from '../lib/retrieval/pipeline-wide';
import { wideRetrievalCorpusFixture } from './fixtures/wide-retrieval-corpus';

describe('retrieval detail', () => {
  it.each([
    ['jev', RETRIEVAL_CONFIG_VERSION],
    ['wide', WIDE_CONFIG_VERSION],
  ] as const)('reports the active config version for %s and preserves key order', (strategy, version) => {
    const detail = retrievalDetail({ strategy, index: wideRetrievalCorpusFixture() });
    expect(JSON.stringify(detail)).toBe(JSON.stringify({
      strategy, retrievalConfigVersion: version, alwaysSuppliedCount: 5, overviewPresent: true,
    }));
  });

  it('counts scope entries, overview entries, and instruction-bearing about units', () => {
    const { units } = wideRetrievalCorpusFixture();
    const groups = [
      units.filter(unit => unit.id.endsWith('-SCOPE')),
      units.filter(unit => unit.kind === 'entry' && unit.document === 'Career Overview'),
      units.filter(unit => unit.kind === 'about'),
    ];
    expect(groups.map(group => retrievalDetail({ strategy: 'wide', index: { units: group } }).alwaysSuppliedCount))
      .toEqual([2, 2, 1]);
    expect(retrievalDetail({ strategy: 'wide', index: { units } }).alwaysSuppliedCount).toBe(5);
  });

  it('reports an absent overview with the real always-supplied count', () => {
    const units = wideRetrievalCorpusFixture().units.filter(unit => unit.document !== 'Career Overview');
    expect(retrievalDetail({ strategy: 'wide', index: { units } })).toEqual({
      strategy: 'wide', retrievalConfigVersion: WIDE_CONFIG_VERSION,
      alwaysSuppliedCount: 3, overviewPresent: false,
    });
  });

  it.each(['jev', 'wide'] as const)('reports null count and overview for a null index with %s', strategy => {
    expect(retrievalDetail({ strategy, index: null })).toEqual({
      strategy, retrievalConfigVersion: strategy === 'wide' ? WIDE_CONFIG_VERSION : RETRIEVAL_CONFIG_VERSION,
      alwaysSuppliedCount: null, overviewPresent: null,
    });
  });
});
