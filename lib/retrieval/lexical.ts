import { isDeepStrictEqual } from 'node:util';

/** NFKC folds compatibility forms; letter/mark runs preserve acronyms as single tokens. */
export const TOKENIZER_VERSION = 'unicode-nfkc-v1';
export function tokenize(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? [];
}
export type LexicalStatistics = {
  documentLengths: number[];
  averageDocumentLength: number;
  terms: { term: string; documentFrequency: number; postings: { documentIndex: number; frequency: number }[] }[];
};

/** Only factual search text contributes: never IDs, prompt instructions or global rules. */
export function buildLexicalStatistics(units: readonly { searchText: string }[]): LexicalStatistics {
  const terms = new Map<string, LexicalStatistics['terms'][number]['postings']>();
  const documentLengths = units.map((unit, documentIndex) => {
    const tokens = tokenize(unit.searchText);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, frequency] of frequencies) {
      if (!terms.has(term)) terms.set(term, []);
      terms.get(term)!.push({ documentIndex, frequency });
    }
    return tokens.length;
  });
  return {
    documentLengths,
    averageDocumentLength: units.length ? documentLengths.reduce((sum, count) => sum + count, 0) / units.length : 0,
    terms: [...terms].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([term, postings]) => ({ term, documentFrequency: postings.length, postings })),
  };
}

/** Recompute from the small corpus to verify every posting/count and reject extra fields. */
export function validateLexicalStatistics(value: unknown, units: readonly { searchText: string }[]): asserts value is LexicalStatistics {
  if (!isDeepStrictEqual(value, buildLexicalStatistics(units))) throw new Error('Retrieval index: lexical statistics mismatch');
}
