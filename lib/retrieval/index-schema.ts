import { createHash } from 'node:crypto';
import type { RetrievalUnit } from './extract';

export type EmbeddingConfig = {
  provider: string;
  model: string;
  /** Absent when the hosted provider exposes no immutable revision. */
  revision?: string;
  dimensions: number;
  encoding: 'float';
  normalization: 'l2';
  documentInputType: 'document';
  queryInputType: 'query';
  textFormatVersion: string;
};
export type IndexReceipt = {
  sourceEntryCount: number;
  totalUnitCount: number;
  embeddedUnitCount: number;
  reusedUnitCount: number;
  providerTokens: number;
  rateUsdPerMillionTokens: number;
  costUsd: number;
  elapsedMs: number;
  warnings: string[];
};
export type RetrievalIndex = {
  schemaVersion: 1;
  corpusVersion: string;
  indexVersion: string;
  builtAt: string;
  extractorVersion: string;
  /** Lexical statistics are a later layer; use "pending" until present. */
  tokenizerVersion: string;
  embedding: EmbeddingConfig;
  units: (RetrievalUnit & { vector: number[] })[];
  globalRules: string;
  receipt: IndexReceipt;
};
export type IndexPayload = Omit<RetrievalIndex, 'indexVersion'>;
export type IndexExpectations = {
  corpusVersion: string;
  embedding: EmbeddingConfig;
  units?: RetrievalUnit[];
  globalRules?: string;
  extractorVersion?: string;
  tokenizerVersion?: string;
};

function fail(message: string): never { throw new Error(`Retrieval index: ${message}`); }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sorted object keys, ordered arrays, and JSON's omission of absent optional fields. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return fail('non-JSON canonical value');
}

/** The build receipt and clock do not change retrieval content identity. */
export function computeIndexVersion(index: IndexPayload | RetrievalIndex): string {
  const content = Object.fromEntries(Object.entries(index).filter(([key]) => !['indexVersion', 'builtAt', 'receipt'].includes(key)));
  return hash(canonical(content));
}

export function validateEmbeddingConfig(value: unknown): asserts value is EmbeddingConfig {
  if (!object(value) || !nonempty(value.provider) || !nonempty(value.model) || !nonempty(value.textFormatVersion)
    || (value.revision !== undefined && !nonempty(value.revision))
    || !count(value.dimensions) || value.dimensions === 0 || value.encoding !== 'float'
    || value.normalization !== 'l2' || value.documentInputType !== 'document' || value.queryInputType !== 'query') fail('invalid embedding configuration');
}

/** Includes all fields identifying the document/query embedding space. */
export function embeddingConfigKey(config: EmbeddingConfig): string {
  validateEmbeddingConfig(config);
  return canonical(config);
}

function validateUnit(value: unknown, dimensions: number): asserts value is RetrievalIndex['units'][number] {
  if (!object(value) || !nonempty(value.id) || !nonempty(value.document) || !nonempty(value.title)
    || !['entry', 'about', 'supplemental'].includes(value.kind as string)
    || !nonempty(value.promptText) || !nonempty(value.searchText)
    || !digest(value.indexedHash) || !digest(value.promptHash)
    || (value.exporterHash !== undefined && !digest(value.exporterHash))) fail('invalid unit');
  if (hash(value.searchText as string) !== value.indexedHash || hash(value.promptText as string) !== value.promptHash) fail('text hash mismatch');
  if (!Array.isArray(value.vector) || value.vector.length !== dimensions || !Array.from(value.vector).every(n => typeof n === 'number' && Number.isFinite(n))) fail('invalid vector dimensions or values');
  if (!value.vector.some(n => n !== 0)) fail('zero vector');
}

/** Validate unknown JSON before it can enter a runtime cache or become a reuse source. */
export function validateRetrievalIndex(value: unknown, expected?: IndexExpectations): RetrievalIndex {
  if (!object(value) || value.schemaVersion !== 1 || !digest(value.corpusVersion) || !digest(value.indexVersion)
    || !nonempty(value.builtAt) || !Number.isFinite(Date.parse(value.builtAt))
    || !nonempty(value.extractorVersion) || !nonempty(value.tokenizerVersion)
    || typeof value.globalRules !== 'string' || !Array.isArray(value.units)) fail('invalid envelope');
  validateEmbeddingConfig(value.embedding);
  const seen = new Set<string>();
  for (const unit of value.units) {
    validateUnit(unit, value.embedding.dimensions);
    if (seen.has(unit.id)) fail('duplicate unit ID');
    seen.add(unit.id);
  }
  const receipt = value.receipt;
  if (!object(receipt) || !count(receipt.sourceEntryCount) || !count(receipt.totalUnitCount)
    || !count(receipt.embeddedUnitCount) || !count(receipt.reusedUnitCount) || !count(receipt.providerTokens)
    || !amount(receipt.rateUsdPerMillionTokens) || !amount(receipt.costUsd) || !amount(receipt.elapsedMs) || !Array.isArray(receipt.warnings)
    || !Array.from(receipt.warnings).every(item => typeof item === 'string')
    || receipt.totalUnitCount !== value.units.length
    || receipt.embeddedUnitCount + receipt.reusedUnitCount !== receipt.totalUnitCount
    || receipt.sourceEntryCount !== value.units.filter(unit => unit.kind === 'entry').length) fail('invalid build receipt accounting');
  const index = value as RetrievalIndex;
  if (computeIndexVersion(index) !== index.indexVersion) fail('checksum mismatch');
  if (expected) {
    if (index.corpusVersion !== expected.corpusVersion) fail('corpus version mismatch');
    if (embeddingConfigKey(index.embedding) !== embeddingConfigKey(expected.embedding)) fail('embedding configuration mismatch');
    if (expected.extractorVersion !== undefined && index.extractorVersion !== expected.extractorVersion) fail('extractor version mismatch');
    if (expected.tokenizerVersion !== undefined && index.tokenizerVersion !== expected.tokenizerVersion) fail('tokenizer version mismatch');
    if (expected.globalRules !== undefined && index.globalRules !== expected.globalRules) fail('global rules mismatch');
    if (expected.units && (index.units.length !== expected.units.length || index.units.some((unit, position) => {
      const source = Object.fromEntries(Object.entries(unit).filter(([key]) => key !== 'vector'));
      return canonical(source) !== canonical(expected.units![position]);
    }))) fail('unit coverage, order or content mismatch');
  }
  return index;
}

export function sealRetrievalIndex(payload: IndexPayload): RetrievalIndex {
  const index = { ...payload, indexVersion: computeIndexVersion(payload) };
  return validateRetrievalIndex(index);
}

/** Scale before computing the norm to avoid overflow/underflow on finite JSON floats. */
export function normalizeIndexVectors(index: RetrievalIndex): Float64Array[] {
  validateRetrievalIndex(index);
  return index.units.map(({ vector }) => {
    const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
    const scaled = vector.map(value => value / scale);
    const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
    return Float64Array.from(scaled, value => value / norm);
  });
}
