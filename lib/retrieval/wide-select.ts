import { renderRetrievalEvidence } from '../prompt';
import type { RetrievalUnit } from './extract';
import type { RankedMatch } from './search';

export const WIDE_SELECTION_CONFIG = Object.freeze({
  version: 'wide-selection-1',
  retrievedLimit: 40,
  // Measured 2026-11-12 on the 61-case coverage run: evidence ranged 36.6-57.5 KB (median 51.4 KB), so
  // 100 KB leaves about 1.7x headroom for corpus growth. The generator limit is 1M tokens and
  // requestByteBound treats a byte as a token (offline receipts show real prompts run at ~0.32
  // tokens per byte), so the cap uses a small fraction of the context.
  maxEvidenceBytes: 100_000,
  alwaysIdSuffix: '-SCOPE',
  alwaysDocumentTitle: 'Career Overview',
});

export type WideSelection =
  | { kind: 'evidence'; always: RetrievalUnit[]; retrieved: RetrievalUnit[]; droppedIds: string[];
      evidenceBytes: number; overviewPresent: boolean }
  | { kind: 'unavailable'; reason: 'no-always-units' | 'always-over-budget' };

export function isAlwaysSupplied(unit: RetrievalUnit): boolean {
  return (unit.kind === 'entry' && (unit.id.endsWith(WIDE_SELECTION_CONFIG.alwaysIdSuffix)
    || unit.document === WIDE_SELECTION_CONFIG.alwaysDocumentTitle))
    || (unit.kind === 'about' && unit.promptText !== unit.searchText);
}

export function selectWideEvidence(input: { units: readonly RetrievalUnit[]; dense: readonly RankedMatch[] }): WideSelection {
  const always = input.units.filter(isAlwaysSupplied);
  if (!always.length) return { kind: 'unavailable', reason: 'no-always-units' };
  const alwaysBytes = Buffer.byteLength(renderRetrievalEvidence(always));
  if (alwaysBytes > WIDE_SELECTION_CONFIG.maxEvidenceBytes) return { kind: 'unavailable', reason: 'always-over-budget' };

  const byId = new Map(input.units.map(unit => [unit.id, unit]));
  const seen = new Set(always.map(unit => unit.id));
  const candidates: RetrievalUnit[] = [];
  for (const match of input.dense) {
    const unit = byId.get(match.id);
    if (!unit || seen.has(unit.id)) continue;
    seen.add(unit.id);
    candidates.push(unit);
    if (candidates.length === WIDE_SELECTION_CONFIG.retrievedLimit) break;
  }

  const retrieved: RetrievalUnit[] = [];
  let evidenceBytes = alwaysBytes;
  let droppedIds: string[] = [];
  for (const [index, unit] of candidates.entries()) {
    const nextBytes = alwaysBytes + Buffer.byteLength(renderRetrievalEvidence([...retrieved, unit]));
    if (nextBytes > WIDE_SELECTION_CONFIG.maxEvidenceBytes) {
      droppedIds = candidates.slice(index).map(candidate => candidate.id);
      break;
    }
    retrieved.push(unit);
    evidenceBytes = nextBytes;
  }

  return {
    kind: 'evidence', always, retrieved, droppedIds, evidenceBytes,
    overviewPresent: always.some(unit => unit.kind === 'entry' && unit.document === WIDE_SELECTION_CONFIG.alwaysDocumentTitle),
  };
}
