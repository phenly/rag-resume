import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildLexicalStatistics, TOKENIZER_VERSION, tokenize } from '../lib/retrieval/lexical';
import { prepareHybridSearch } from '../lib/retrieval/search';
import { computeIndexVersion, sealRetrievalIndex, validateRetrievalIndex, type IndexPayload } from '../lib/retrieval/index-schema';
import { buildRetrievalIndex } from '../lib/retrieval/build-index';
import { VOYAGE_EMBEDDING_CONFIG } from '../lib/retrieval/voyage';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function payload(documents = [
  { id: 'EX-B', searchText: 'widgets CAPI', vector: [0, 1] },
  { id: 'EX-A', searchText: 'widgets analytics', vector: [1, 0] },
]): IndexPayload {
  const units = documents.map(document => ({ ...document, kind: 'entry' as const, document: 'FictionalCo', title: 'Scope', promptText: document.searchText + '\nRule: secret-instruction', indexedHash: hash(document.searchText), promptHash: hash(document.searchText + '\nRule: secret-instruction') }));
  return { schemaVersion: 1, corpusVersion: 'a'.repeat(64), builtAt: '2026-11-06T12:00:00Z', extractorVersion: '1', tokenizerVersion: TOKENIZER_VERSION,
    lexical: buildLexicalStatistics(units), units, globalRules: '',
    embedding: { provider: 'fictional', model: 'fixture', dimensions: 2, encoding: 'float', normalization: 'l2', documentInputType: 'document', queryInputType: 'query', textFormatVersion: '1' },
    receipt: { sourceEntryCount: units.length, totalUnitCount: units.length, embeddedUnitCount: units.length, reusedUnitCount: 0, providerTokens: 0, rateUsdPerMillionTokens: 0, costUsd: 0, elapsedMs: 0, warnings: [] } };
}

describe('deterministic offline hybrid retrieval', () => {
  it('normalizes Unicode forms and keeps acronyms, numbers and accented words intact', () => {
    expect(tokenize('ＣＡＰＩ CAPI ２０２６ cafe\u0301 naïve API/v2')).toEqual(['capi', 'capi', '2026', 'café', 'naïve', 'api', 'v2']);
  });
  it('computes weighted BM25 and one-based RRF against independently calculated scores', () => {
    const result = prepareHybridSearch(sealRetrievalIndex(payload())).search({ question: 'CAPI', context: 'analytics', vector: [1, 0] });
    expect(result.dense).toEqual([{ id: 'EX-A', score: 1 }, { id: 'EX-B', score: 0 }]);
    expect(result.lexical.map(match => match.id)).toEqual(['EX-B', 'EX-A']);
    expect(result.lexical[0].score).toBeCloseTo(2 * Math.log(2));
    expect(result.lexical[1].score).toBeCloseTo(Math.log(2));
    expect(result.fused.map(match => match.id)).toEqual(['EX-A', 'EX-B']);
    expect(result.fused[0]).toMatchObject({ denseRank: 1, lexicalRank: 2 });
    expect(result.fused[0].score).toBeCloseTo(1 / 61 + 1 / 62);
  });
  it('uses document lengths in BM25 and excludes zero lexical matches', () => {
    const index = sealRetrievalIndex(payload([
      { id: 'EX-LONG', searchText: 'CAPI extra extra extra', vector: [1, 0] },
      { id: 'EX-SHORT', searchText: 'CAPI', vector: [1, 0] },
      { id: 'EX-UNRELATED', searchText: 'other', vector: [1, 0] },
    ]));
    const { lexical } = prepareHybridSearch(index).search({ question: 'CAPI', vector: [1, 0] });
    expect(lexical.map(match => match.id)).toEqual(['EX-SHORT', 'EX-LONG']);
    const idf = Math.log(1 + 1.5 / 2.5);
    expect(lexical[0].score).toBeCloseTo(2 * idf * 2.2 / (1 + 1.2 * (0.25 + 0.75 / 2)));
  });
  it('returns dense paraphrase matches without requiring lexical overlap', () => {
    const result = prepareHybridSearch(sealRetrievalIndex(payload())).search({ question: 'measurement', vector: [1, 0] });
    expect(result.lexical).toEqual([]);
    expect(result.fused[0]).toEqual({ id: 'EX-A', score: 1 / 61, denseRank: 1 });
  });
  it('bounds stages to 24, breaks all ties by code-point ID, and preserves stage ranks', () => {
    const documents = Array.from({ length: 30 }, (_, i) => ({ id: `EX-${String(29 - i).padStart(2, '0')}`, searchText: 'widgets', vector: [1, 0] }));
    const result = prepareHybridSearch(sealRetrievalIndex(payload(documents))).search({ question: 'widgets', vector: [3, 0] });
    expect(result.dense).toHaveLength(24); expect(result.lexical).toHaveLength(24); expect(result.fused).toHaveLength(24);
    expect(result.fused[0]).toEqual({ id: 'EX-00', score: 2 / 61, denseRank: 1, lexicalRank: 1 });
    expect(result.fused.at(-1)?.id).toBe('EX-23');
  });
  it('does not match IDs, instructions or global rules and handles empty lexical inputs', () => {
    const value = payload(); value.globalRules = 'private-marker';
    const search = prepareHybridSearch(sealRetrievalIndex(value));
    for (const question of ['EX-B', 'secret-instruction', 'private-marker', '?!']) {
      expect(search.search({ question, vector: [1, 0] }).lexical).toEqual([]);
    }
    const empty = prepareHybridSearch(sealRetrievalIndex(payload([]))).search({ question: 'CAPI', vector: [1, 0] });
    expect(empty).toEqual({ dense: [], lexical: [], fused: [] });
  });
  it('owns a validated snapshot and safely normalizes extreme finite query floats', () => {
    const index = sealRetrievalIndex(payload());
    const search = prepareHybridSearch(index);
    index.units[0].id = 'MUTATED'; index.lexical!.terms.length = 0;
    for (const scalar of [Number.MAX_VALUE, Number.MIN_VALUE]) {
      const result = search.search({ question: 'CAPI', vector: [scalar, scalar] });
      expect(result.dense.every(match => Number.isFinite(match.score))).toBe(true);
      expect(result.lexical[0].id).toBe('EX-B');
    }
  });
  it('rejects zero, wrong-dimension, sparse and nonfinite query vectors', () => {
    const search = prepareHybridSearch(sealRetrievalIndex(payload()));
    for (const vector of [[0, 0], [1], [NaN, 1], [Infinity, 0], [, 1]]) {
      expect(() => search.search({ question: 'widgets', vector: vector as number[] })).toThrow('query vector');
    }
  });
  it('validates every lexical statistic even when the checksum was recomputed', () => {
    const variants = [
      (v: IndexPayload) => { v.lexical!.documentLengths[0]++; },
      (v: IndexPayload) => { v.lexical!.averageDocumentLength++; },
      (v: IndexPayload) => { v.lexical!.terms[0].documentFrequency++; },
      (v: IndexPayload) => { v.lexical!.terms[0].postings[0].frequency++; },
      (v: IndexPayload) => { v.lexical!.terms[0].postings[0].documentIndex = 99; },
      (v: IndexPayload) => { v.lexical!.terms.reverse(); },
      (v: IndexPayload) => { delete v.lexical; },
    ];
    for (const mutate of variants) {
      const value = payload(); mutate(value);
      expect(() => validateRetrievalIndex({ ...value, indexVersion: computeIndexVersion(value) })).toThrow('lexical statistics');
    }
  });
  it('accepts legacy artifacts for embedding reuse but refuses them for search readiness', async () => {
    const value = payload(); value.tokenizerVersion = 'pending'; delete value.lexical;
    value.embedding = { ...VOYAGE_EMBEDDING_CONFIG }; value.units.forEach(unit => { unit.vector = Array.from({ length: 1024 }, (_, i) => i ? 0 : 1); });
    const previous = sealRetrievalIndex(value);
    expect(() => prepareHybridSearch(previous)).toThrow('current lexical statistics');
    const embed = vi.fn(async () => { throw new Error('must reuse'); });
    const units = value.units.map(({ vector, ...unit }) => { void vector; return unit; });
    const rebuilt = await buildRetrievalIndex({ snapshot: { corpusVersion: value.corpusVersion, extraction: { units, globalRules: '', sourceEntryCount: 2, supplementalCount: 0, spans: [] } }, previous, embedding: VOYAGE_EMBEDDING_CONFIG, embedder: { embed } });
    expect(embed).not.toHaveBeenCalled();
    expect(rebuilt.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(rebuilt.lexical).toEqual(buildLexicalStatistics(units));
    expect(rebuilt.receipt.reusedUnitCount).toBe(2);
  });
});
