import { normalizeIndexVectors, validateRetrievalIndex, type RetrievalIndex } from './index-schema';
import { TOKENIZER_VERSION, tokenize } from './lexical';

export const HYBRID_SEARCH_CONFIG = Object.freeze({ k1: 1.2, b: 0.75, denseLimit: 24, lexicalLimit: 24, candidateLimit: 24, rrfK: 60, questionWeight: 2, contextWeight: 1 });
export type RankedMatch = { id: string; score: number };
export type FusedMatch = RankedMatch & { denseRank?: number; lexicalRank?: number };
export type SearchTrace = { dense: RankedMatch[]; lexical: RankedMatch[]; fused: FusedMatch[] };
export type SearchLimits = { denseLimit?: number; lexicalLimit?: number; candidateLimit?: number };
export type HybridQuery = {
  question: string;
  /** Already bounded, verified context retained by the query builder, without labels. */
  context?: string;
  /** Embedding of the bounded contextual query in the index's configured query space. */
  vector: readonly number[];
};
const stableRank = (a: RankedMatch, b: RankedMatch) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function normalizeQuery(vector: readonly number[], dimensions: number): Float64Array {
  if (vector.length !== dimensions || !Array.from(vector).every(value => typeof value === 'number' && Number.isFinite(value))) throw new Error('Retrieval search: invalid query vector');
  const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
  if (scale === 0) throw new Error('Retrieval search: zero query vector');
  const scaled = Array.from(vector, value => value / scale);
  const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return Float64Array.from(scaled, value => value / norm);
}

/** Validate and normalize once. No provider calls; query vectors must come from the matching adapter. */
export function prepareHybridSearch(input: RetrievalIndex): { search(query: HybridQuery, limits?: SearchLimits): SearchTrace } {
  validateRetrievalIndex(input);
  if (input.tokenizerVersion !== TOKENIZER_VERSION || !input.lexical) throw new Error('Retrieval search: index has no current lexical statistics');
  // Own the snapshot so later caller mutations cannot bypass validation or change ranking.
  const index = structuredClone(input);
  const vectors = normalizeIndexVectors(index);
  const ids = index.units.map(unit => unit.id);
  const lexical = index.lexical!;
  const config = HYBRID_SEARCH_CONFIG;
  return { search({ question, context = '', vector }: HybridQuery, limits: SearchLimits = {}): SearchTrace {
    const { denseLimit = config.denseLimit, lexicalLimit = config.lexicalLimit, candidateLimit = config.candidateLimit } = limits;
    for (const limit of [denseLimit, lexicalLimit, candidateLimit]) {
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('Retrieval search: invalid limit');
    }
    const query = normalizeQuery(vector, index.embedding.dimensions);
    const dense = vectors.map((document, i) => {
      let score = 0;
      for (let j = 0; j < query.length; j++) score += query[j] * document[j];
      return { id: ids[i], score: Math.max(-1, Math.min(1, score)) };
    }).sort(stableRank).slice(0, denseLimit);
    const weights = new Map<string, number>();
    for (const [text, weight] of [[question, config.questionWeight], [context, config.contextWeight]] as const) {
      for (const term of tokenize(text)) weights.set(term, (weights.get(term) ?? 0) + weight);
    }
    const scores = new Float64Array(ids.length);
    for (const { term, documentFrequency, postings } of lexical.terms) {
      const weight = weights.get(term);
      if (!weight) continue;
      const idf = Math.log(1 + (ids.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      for (const { documentIndex, frequency } of postings) {
        const lengthRatio = lexical.averageDocumentLength ? lexical.documentLengths[documentIndex] / lexical.averageDocumentLength : 0;
        const denominator = frequency + config.k1 * (1 - config.b + config.b * lengthRatio);
        scores[documentIndex] += weight * idf * frequency * (config.k1 + 1) / denominator;
      }
    }
    const lexicalMatches = Array.from(scores, (score, i) => ({ id: ids[i], score }))
      .filter(match => match.score > 0).sort(stableRank).slice(0, lexicalLimit);
    const fused = new Map<string, FusedMatch>();
    for (const [matches, field] of [[dense, 'denseRank'], [lexicalMatches, 'lexicalRank']] as const) {
      matches.forEach(({ id }, offset) => {
        const rank = offset + 1;
        const match = fused.get(id) ?? { id, score: 0 };
        match[field] = rank;
        match.score += 1 / (config.rrfK + rank);
        fused.set(id, match);
      });
    }
    return { dense, lexical: lexicalMatches, fused: [...fused.values()].sort(stableRank).slice(0, candidateLimit) };
  } };
}
