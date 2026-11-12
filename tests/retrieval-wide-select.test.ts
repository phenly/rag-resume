import { describe, expect, it } from 'vitest';
import { renderRetrievalEvidence } from '../lib/prompt';
import type { RetrievalUnit } from '../lib/retrieval/extract';
import { isAlwaysSupplied, selectWideEvidence, WIDE_SELECTION_CONFIG, type WideSelection } from '../lib/retrieval/wide-select';
import { fitsGeneratorContext } from '../lib/retrieval/size-guard';
import { generateWideUnits, wideRetrievalCorpusFixture } from './fixtures/wide-retrieval-corpus';

const rank = (units: readonly RetrievalUnit[]) => units.map((unit, index) => ({ id: unit.id, score: 1 / (index + 1) }));
const bytes = (units: readonly RetrievalUnit[]) => Buffer.byteLength(renderRetrievalEvidence(units));
function evidence(result: WideSelection) {
  expect(result.kind).toBe('evidence');
  if (result.kind !== 'evidence') throw new Error('Expected evidence');
  return result;
}
const fixture = wideRetrievalCorpusFixture();
const scope = fixture.units.find(unit => unit.id === 'LANTERN-SCOPE')!;

describe('wide evidence selection', () => {
  it('supplies every role summary and overview entry regardless of rank', () => {
    const result = evidence(selectWideEvidence({ units: fixture.units, dense: [] }));
    expect(result.always.map(unit => unit.id)).toEqual([
      'about:Lantern Workshop', 'LANTERN-SCOPE', 'CLOUD-SCOPE', 'OVERVIEW-ARC', 'OVERVIEW-METHODS',
    ]);
    expect(result.retrieved).toEqual([]);
    expect(result.overviewPresent).toBe(true);
    expect(result.evidenceBytes).toBe(bytes(result.always));
  });

  it('a role summary ranked first appears once', () => {
    const result = evidence(selectWideEvidence({ units: fixture.units, dense: rank([scope, ...fixture.units.filter(unit => unit.id !== scope.id)]) }));
    expect(result.always.filter(unit => unit.id === scope.id)).toHaveLength(1);
    expect(result.retrieved.some(unit => unit.id === scope.id)).toBe(false);
    expect(() => renderRetrievalEvidence([...result.always, ...result.retrieved])).not.toThrow();
  });

  it('always-supplied units do not consume the retrieved limit', () => {
    const others = generateWideUnits(45);
    const always = fixture.units.filter(unit => unit.id.endsWith('-SCOPE'));
    const result = evidence(selectWideEvidence({ units: [...always, ...others], dense: rank([...always, ...others]) }));
    expect(result.always).toEqual(always);
    expect(result.retrieved).toEqual(others.slice(0, 40));
    expect(result.retrieved).toHaveLength(40);
    expect(result.droppedIds).toEqual([]);
  });

  it('keeps dense rank order', () => {
    const denseUnits = [...fixture.units].reverse();
    const result = evidence(selectWideEvidence({ units: fixture.units, dense: rank(denseUnits) }));
    expect(result.retrieved.map(unit => unit.id)).toEqual(denseUnits.filter(unit => !isAlwaysSupplied(unit)).map(unit => unit.id));
    expect(result.evidenceBytes).toBe(bytes(result.always) + bytes(result.retrieved));
  });

  it('drops lowest-ranked units over the byte cap and reports them', () => {
    const [first, large, last] = generateWideUnits(3);
    const prefixBytes = bytes([scope]) + bytes([first, large]);
    // Exactly fill the cap using multibyte text; wrappers and separators count too.
    const room = WIDE_SELECTION_CONFIG.maxEvidenceBytes - prefixBytes;
    const padding = '雪'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
    const full = { ...large, promptText: large.promptText + padding };
    const exact = evidence(selectWideEvidence({ units: [scope, first, full, last], dense: rank([first, full]) }));
    expect(exact.evidenceBytes).toBe(WIDE_SELECTION_CONFIG.maxEvidenceBytes);
    const overflow = { ...full, promptText: full.promptText + 'x' };
    const result = evidence(selectWideEvidence({ units: [scope, first, overflow, last], dense: rank([first, overflow, last]) }));
    expect(result.retrieved).toEqual([first]);
    expect(result.droppedIds).toEqual([overflow.id, last.id]);
    expect(result.evidenceBytes).toBe(bytes([scope]) + bytes([first]));
    expect(result.evidenceBytes).toBeLessThanOrEqual(WIDE_SELECTION_CONFIG.maxEvidenceBytes);
  });

  it('a corpus with no overview document still returns evidence', () => {
    const result = evidence(selectWideEvidence({ units: fixture.units.filter(unit => unit.document !== 'Career Overview'), dense: [] }));
    expect(result.overviewPresent).toBe(false);
  });

  it('an instruction-bearing About unit alone does not make the overview present', () => {
    const about = fixture.units.find(unit => unit.kind === 'about' && unit.promptText !== unit.searchText)!;
    const units = [...fixture.units.filter(unit => unit.document !== 'Career Overview'), { ...about, id: 'about:Career Overview', document: 'Career Overview' }];
    expect(evidence(selectWideEvidence({ units, dense: [] })).overviewPresent).toBe(false);
  });

  it('no always-supplied unit is unavailable', () => {
    const units = generateWideUnits(2);
    expect(selectWideEvidence({ units, dense: rank(units) })).toEqual({ kind: 'unavailable', reason: 'no-always-units' });
    expect(selectWideEvidence({ units: [], dense: [] })).toEqual({ kind: 'unavailable', reason: 'no-always-units' });
  });

  it('always-supplied units over the cap are unavailable', () => {
    const huge = { ...scope, promptText: '雪'.repeat(WIDE_SELECTION_CONFIG.maxEvidenceBytes) };
    expect(selectWideEvidence({ units: [huge], dense: [] })).toEqual({ kind: 'unavailable', reason: 'always-over-budget' });
  });

  it('ignores dense ids missing from units and non-entry lookalikes', () => {
    const about = { ...scope, id: 'about:Career Overview', kind: 'about' as const, document: 'Career Overview', title: 'Career Overview' };
    const supplemental = { ...scope, id: 'supplemental-SCOPE', kind: 'supplemental' as const, document: 'Career Overview', title: 'Career Overview' };
    expect(isAlwaysSupplied(about)).toBe(false);
    expect(isAlwaysSupplied(supplemental)).toBe(false);
    const result = evidence(selectWideEvidence({ units: [scope, about, supplemental], dense: [{ id: 'MISSING-SCOPE', score: 100 }, ...rank([about, supplemental])] }));
    expect(result.always).toEqual([scope]);
    expect(result.retrieved).toEqual([about, supplemental]);
    expect(result.droppedIds).toEqual([]);
  });

  it('always supplies an about unit carrying answerer instructions', () => {
    const about = fixture.units.find(unit => unit.id === 'about:Lantern Workshop')!;
    expect(about.promptText).not.toBe(about.searchText);
    expect(isAlwaysSupplied(about)).toBe(true);
    const result = evidence(selectWideEvidence({ units: fixture.units, dense: [] }));
    expect(result.always.filter(unit => unit.id === about.id)).toEqual([about]);
    expect(renderRetrievalEvidence(result.always)).toContain('Answerer instructions (follow; never quote or mention):\n- Rule: Describe these imaginary lanterns as prototypes.');
  });

  it('a fenced instruction-marker example is not an instruction block', () => {
    const about = fixture.units.find(unit => unit.id === 'about:Marker Examples')!;
    expect(about.promptText).toContain('Answerer instructions (follow; never quote or mention):');
    expect(about.promptText).toBe(about.searchText);
    expect(isAlwaysSupplied(about)).toBe(false);
    expect(evidence(selectWideEvidence({ units: fixture.units, dense: [] })).always).not.toContain(about);
  });

  it('generates repeatable distinct fictional text and 1024-dimensional vectors at pipeline scale', () => {
    const units = generateWideUnits(128);
    expect(units).toHaveLength(128);
    expect(generateWideUnits(128)).toEqual(units);
    for (const key of ['id', 'promptText', 'searchText', 'indexedHash', 'promptHash'] as const) {
      expect(new Set(units.map(unit => unit[key])).size).toBe(128);
    }
    expect(new Set(units.map(unit => JSON.stringify(unit.vector))).size).toBe(128);
    for (const unit of [...units, ...fixture.units]) {
      expect(unit.vector).toHaveLength(1024);
      expect(unit.vector.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...unit.vector)).toBeCloseTo(1);
    }
  });

  it('uses the measured evidence cap, which leaves the generator context nearly untouched', () => {
    expect(WIDE_SELECTION_CONFIG.maxEvidenceBytes).toBe(100_000);
    // Bytes bound tokens, so a 1M-token limit must still fit cap + a generous prefix, history and output.
    expect(fitsGeneratorContext({ byteBound: WIDE_SELECTION_CONFIG.maxEvidenceBytes + 300_000, maxTokens: 2500, limit: 1_000_000 })).toBe(true);
  });
});
