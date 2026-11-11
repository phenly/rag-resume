import type { RagPipeline } from '../retrieval/pipeline';
import { retrievalMetrics } from './runner';
import type { EvalCase } from './types';

export type CoverageRow = { id: string; hasGold: boolean; resolution: 'evidence' | 'unavailable' | 'cancelled';
  fullGoldSupplied?: boolean; fullGoldInDense64?: boolean; fullGoldWithLexical24?: boolean;
  missing?: { id: string; denseRank: number | null; inAlways: boolean }[];
  alwaysCount: number; retrievedCount: number; evidenceBytes: number; embeddingTokens?: number; elapsedMs: number };

/** Resolve retrieval only. Each fixture history is trusted offline evidence. */
export async function coverageRows(input: { cases: EvalCase[]; pipeline: RagPipeline }): Promise<CoverageRow[]> {
  const rows: CoverageRow[] = [];
  for (const c of input.cases) {
    const result = await input.pipeline.resolve({ question: c.question, verifiedHistory: c.history });
    if (result.trace.strategy !== 'wide' || (result.kind !== 'evidence' && result.kind !== 'unavailable' && result.kind !== 'cancelled'))
      throw new Error('Coverage requires a wide retrieval pipeline');
    const { trace } = result;
    const always = result.kind === 'evidence' ? (result.always ?? []).map(unit => unit.id) : [];
    const retrieved = result.kind === 'evidence' ? result.selected.map(unit => unit.id) : [];
    const supplied = [...always, ...retrieved];
    const hasGold = (c.goldChunkSets ?? [c.goldChunks]).some(set => set.length > 0);
    const row: CoverageRow = {
      id: c.id, hasGold, resolution: result.kind, alwaysCount: always.length, retrievedCount: retrieved.length,
      evidenceBytes: trace.wide?.evidenceBytes ?? 0, elapsedMs: trace.elapsedMs,
      ...(trace.embedding?.status === 'complete' ? { embeddingTokens: trace.embedding.inputTokens } : {}),
    };
    // A missing search is an interrupted diagnostic, not proof of an absent ID.
    if (hasGold && trace.search) {
      const metrics = retrievalMetrics(c, supplied);
      const gold = (c.goldChunkSets ?? [c.goldChunks])[metrics.selectedGoldSetIndex ?? 0];
      const ranks = new Map(trace.search.dense.map((item, index) => [item.id, index + 1]));
      row.fullGoldSupplied = metrics.recallAtK === 1;
      row.fullGoldInDense64 = retrievalMetrics(c, trace.search.dense.slice(0, 64).map(item => item.id)).recallAtK === 1;
      row.fullGoldWithLexical24 = retrievalMetrics(c, [...supplied, ...trace.search.lexical.slice(0, 24).map(item => item.id)]).recallAtK === 1;
      row.missing = gold.filter(id => !supplied.includes(id)).map(id => ({ id, denseRank: ranks.get(id) ?? null, inAlways: always.includes(id) }));
    }
    rows.push(row);
  }
  return rows;
}

export function coverageSummary(rows: CoverageRow[]): { goldCases: number; fullGoldSupplied: number; unavailable: number;
  lexicalWouldRescue: string[]; maxEvidenceBytes: number; medianElapsedMs: number; embeddingTokens: number } {
  const elapsed = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(elapsed.length / 2);
  return {
    goldCases: rows.filter(row => row.hasGold).length,
    fullGoldSupplied: rows.filter(row => row.hasGold && row.fullGoldSupplied).length,
    unavailable: rows.filter(row => row.resolution === 'unavailable').length,
    lexicalWouldRescue: rows.filter(row => row.hasGold && row.fullGoldSupplied === false && row.fullGoldWithLexical24).map(row => row.id),
    maxEvidenceBytes: rows.reduce((max, row) => Math.max(max, row.evidenceBytes), 0),
    medianElapsedMs: elapsed.length ? (elapsed.length % 2 ? elapsed[middle] : (elapsed[middle - 1] + elapsed[middle]) / 2) : 0,
    embeddingTokens: rows.reduce((sum, row) => sum + (row.embeddingTokens ?? 0), 0),
  };
}
