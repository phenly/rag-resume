import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeIndexVersion, embeddingConfigKey, normalizeIndexVectors, sealRetrievalIndex,
  validateRetrievalIndex, type EmbeddingConfig, type IndexPayload,
} from '../lib/retrieval/index-schema';
import type { RetrievalUnit } from '../lib/retrieval/extract';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const embedding: EmbeddingConfig = {
  provider: 'fictional', model: 'sample-v1', dimensions: 2, encoding: 'float', normalization: 'l2',
  documentInputType: 'document', queryInputType: 'query', textFormatVersion: '1',
};
function unit(id: string): RetrievalUnit {
  const searchText = `${id} Fictional evidence.`;
  const promptText = `${searchText}\nAnswerer instructions: be concise.`;
  return { id, kind: 'entry', document: 'ExampleCo', title: id, searchText, promptText, indexedHash: hash(searchText), promptHash: hash(promptText) };
}
function payload(): IndexPayload {
  return {
    schemaVersion: 1, corpusVersion: 'a'.repeat(64), builtAt: '2026-11-06T12:00:00.000Z',
    extractorVersion: '1', tokenizerVersion: 'pending', embedding: { ...embedding }, globalRules: 'Keep private topics private.',
    units: [{ ...unit('EX-ONE'), vector: [3, 4] }, { ...unit('EX-TWO'), vector: [4, 3] }],
    receipt: { sourceEntryCount: 2, totalUnitCount: 2, embeddedUnitCount: 2, reusedUnitCount: 0, providerTokens: 10,
      rateUsdPerMillionTokens: 0.12, costUsd: 0.0000012, elapsedMs: 25, warnings: [] },
  };
}
const expected = () => ({ corpusVersion: 'a'.repeat(64), embedding, units: [unit('EX-ONE'), unit('EX-TWO')], globalRules: 'Keep private topics private.', extractorVersion: '1', tokenizerVersion: 'pending' });

describe('retrieval index schema', () => {
  it('round-trips JSON and returns independent normalized typed vectors', () => {
    const index = validateRetrievalIndex(JSON.parse(JSON.stringify(sealRetrievalIndex(payload()))), expected());
    const normalized = normalizeIndexVectors(index);
    expect(normalized[0]).toBeInstanceOf(Float64Array);
    expect(Array.from(normalized[0])).toEqual([0.6, 0.8]);
    expect(index.units[0].vector).toEqual([3, 4]);
  });

  it('canonicalizes object order and absent optional fields without reordering arrays', () => {
    const first = payload();
    const reordered = Object.fromEntries(Object.entries(first).reverse()) as IndexPayload;
    reordered.embedding = Object.fromEntries(Object.entries(embedding).reverse()) as EmbeddingConfig;
    reordered.units[0].exporterHash = undefined;
    expect(computeIndexVersion(reordered)).toBe(computeIndexVersion(first));
    const shuffled = payload(); shuffled.units.reverse();
    expect(computeIndexVersion(shuffled)).not.toBe(computeIndexVersion(first));
  });

  it('keeps rebuild receipts and clocks outside content identity', () => {
    const first = payload(); const reused = payload();
    reused.builtAt = '2026-11-07T12:00:00.000Z';
    reused.receipt = { ...reused.receipt, embeddedUnitCount: 0, reusedUnitCount: 2, providerTokens: 0, costUsd: 0, elapsedMs: 1 };
    expect(sealRetrievalIndex(first).indexVersion).toBe(sealRetrievalIndex(reused).indexVersion);
    reused.corpusVersion = 'b'.repeat(64);
    expect(computeIndexVersion(first)).not.toBe(computeIndexVersion(reused));
  });

  it('rejects changed content even if the caller supplies the previous checksum', () => {
    const index = sealRetrievalIndex(payload()); index.globalRules += ' Changed.';
    expect(() => validateRetrievalIndex(index)).toThrow('checksum mismatch');
  });

  it.each(['promptText', 'searchText'] as const)('verifies %s against its own hash', field => {
    const index = payload(); index.units[0][field] += ' Altered.';
    expect(() => sealRetrievalIndex(index)).toThrow('text hash mismatch');
  });

  it.each([[0, 0], [1], [NaN, 1], [Infinity, 1], ['1', 2]])('rejects malformed vector %j', (...vector) => {
    const index = payload(); index.units[0].vector = vector as number[];
    expect(() => sealRetrievalIndex(index)).toThrow('Retrieval index:');
  });

  it('normalizes extreme finite vectors safely', () => {
    for (const vector of [[Number.MAX_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE, Number.MIN_VALUE]]) {
      const index = payload(); index.units[0].vector = vector;
      const normalized = normalizeIndexVectors(sealRetrievalIndex(index))[0];
      expect(normalized.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...normalized)).toBeCloseTo(1);
    }
  });

  it('rejects sparse vectors and nonfinite receipt amounts before persistence', () => {
    const sparse = sealRetrievalIndex(payload());
    delete sparse.units[0].vector[1];
    expect(() => validateRetrievalIndex(sparse)).toThrow('invalid vector');
    for (const invalid of [NaN, Infinity]) {
      const value = payload(); value.receipt.costUsd = invalid;
      expect(() => sealRetrievalIndex(value)).toThrow('accounting');
    }
  });

  it('rejects missing, duplicate, reordered and substituted units against the extracted snapshot', () => {
    const missing = payload(); missing.units.pop();
    expect(() => sealRetrievalIndex(missing)).toThrow('accounting');
    const duplicate = payload(); duplicate.units[1] = duplicate.units[0];
    expect(() => sealRetrievalIndex(duplicate)).toThrow('duplicate unit ID');
    const reordered = payload(); reordered.units.reverse();
    expect(() => validateRetrievalIndex(sealRetrievalIndex(reordered), expected())).toThrow('coverage, order or content');
    const substituted = payload(); substituted.units[0].title = 'Another title';
    expect(() => validateRetrievalIndex(sealRetrievalIndex(substituted), expected())).toThrow('coverage, order or content');
  });

  it.each(['provider', 'model', 'revision', 'dimensions', 'encoding', 'normalization', 'documentInputType', 'queryInputType', 'textFormatVersion'] as const)('rejects %s config mismatches', field => {
    const wanted = expected();
    wanted.embedding = { ...wanted.embedding, [field]: field === 'dimensions' ? 3 : 'different' } as EmbeddingConfig;
    expect(() => validateRetrievalIndex(sealRetrievalIndex(payload()), wanted)).toThrow(/embedding configuration/);
  });

  it('rejects stale corpus and extraction configuration plus changed global rules', () => {
    for (const overrides of [{ corpusVersion: 'b'.repeat(64) }, { extractorVersion: '2' }, { tokenizerVersion: '2' }, { globalRules: 'Other rules.' }]) {
      expect(() => validateRetrievalIndex(sealRetrievalIndex(payload()), { ...expected(), ...overrides })).toThrow('mismatch');
    }
  });

  it.each(['sourceEntryCount', 'totalUnitCount', 'embeddedUnitCount', 'reusedUnitCount', 'providerTokens', 'rateUsdPerMillionTokens', 'costUsd', 'elapsedMs'] as const)('rejects invalid receipt %s', field => {
    const value = payload(); value.receipt[field] = -1;
    expect(() => sealRetrievalIndex(value)).toThrow('accounting');
  });

  it('rejects an unsupported schema and malformed metadata', () => {
    const valid = sealRetrievalIndex(payload());
    for (const invalid of [null, [], { ...valid, schemaVersion: 2 }, { ...valid, builtAt: 'today' }, { ...valid, corpusVersion: 'short' }]) {
      expect(() => validateRetrievalIndex(invalid)).toThrow('invalid envelope');
    }
    expect(() => embeddingConfigKey({ ...embedding, dimensions: 0 })).toThrow('invalid embedding');
  });
});
