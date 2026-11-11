import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCoverageCli } from '../scripts/retrieval-coverage';
import { coverageRows, coverageSummary } from '../lib/eval/coverage';
import type { EvalCase } from '../lib/eval/types';
import type { RagPipeline, RagResolution, RagTrace } from '../lib/retrieval/pipeline';
import { generateWideUnits } from './fixtures/wide-retrieval-corpus';

const units = generateWideUnits(128);
const ids = units.map(unit => unit.id);
const fixtureCase = (id: string, goldChunks: string[] = [], extra: Partial<EvalCase> = {}): EvalCase => ({
  id, question: `Which fictional orchard trial supports ${id}?`, category: 'grounded', status: 'decided',
  rubric: 'Describe fictional trials.', mustSay: [], mustNotSay: [], goldChunks, source: 'fiction', ...extra,
});
const trace = (extra: Partial<RagTrace> = {}): RagTrace => ({
  strategy: 'wide', retrievalConfigVersion: 'fiction', elapsedMs: 12, stages: {},
  search: { dense: ids.map((id, index) => ({ id, score: 1 / (index + 1) })), lexical: [], fused: [] },
  embedding: { status: 'complete', inputTokens: 7, costUsd: 0 }, ...extra,
});
function evidence(always = [units[0]], selected = [units[1]], extra: Partial<RagTrace> = {}): RagResolution {
  return { kind: 'evidence', always, selected, trace: trace({
    wide: { alwaysIds: always.map(u => u.id), retrievedIds: selected.map(u => u.id), droppedIds: [], evidenceBytes: 321, overviewPresent: true },
    ...extra,
  }) };
}
function pipeline(...results: RagResolution[]): RagPipeline {
  return { ready: true, resolve: vi.fn(async () => results.shift()!) };
}

describe('wide retrieval coverage', () => {
  it('counts a case as covered only when one complete gold option is supplied', async () => {
    const rows = await coverageRows({ cases: [
      fixtureCase('complete', ids.slice(0, 2)), fixtureCase('partial', ids.slice(0, 3)),
      fixtureCase('alternative', [], { goldChunkSets: [[ids[3], ids[4]], ids.slice(0, 2)] }),
      fixtureCase('mixed', [], { goldChunkSets: [[ids[0], ids[3]], [ids[1], ids[4]]] }),
    ], pipeline: pipeline(evidence(), evidence(), evidence(), evidence()) });
    expect(rows.map(row => row.fullGoldSupplied)).toEqual([true, false, true, false]);
    expect(rows[3].missing).toEqual([{ id: ids[3], denseRank: 4, inAlways: false }]);
    expect(coverageSummary(rows)).toMatchObject({ goldCases: 4, fullGoldSupplied: 2 });
  });

  it('reports dense rank over every indexed unit', async () => {
    const [row] = await coverageRows({ cases: [fixtureCase('deep', [ids[71], ids[127], 'ORCHARD-ABSENT'])], pipeline: pipeline(evidence()) });
    expect(row.missing).toEqual([
      { id: ids[71], denseRank: 72, inAlways: false },
      { id: ids[127], denseRank: 128, inAlways: false },
      { id: 'ORCHARD-ABSENT', denseRank: null, inAlways: false },
    ]);
    expect(row.fullGoldInDense64).toBe(false);
    const [denseOnly] = await coverageRows({ cases: [fixtureCase('dense-only', [ids[20]])], pipeline: pipeline(evidence()) });
    expect(denseOnly).toMatchObject({ fullGoldSupplied: false, fullGoldInDense64: true });
  });

  it('flags cases keyword hits would rescue', async () => {
    const search = trace().search!;
    const lexical = Array.from({ length: 24 }, (_, index) => ({ id: ids[index + 64], score: 1 }));
    lexical.push({ id: ids[127], score: 0.1 });
    const rows = await coverageRows({ cases: [
      fixtureCase('rescued', [ids[0], ids[71]]),
      fixtureCase('not-rescued', [ids[127]]),
      fixtureCase('already-covered', [ids[0]]),
      fixtureCase('alternative-rescue', [], { goldChunkSets: [[ids[0], 'ORCHARD-ABSENT'], [ids[71]]] }),
    ], pipeline: pipeline(...Array.from({ length: 4 }, () => evidence(undefined, undefined, { search: { ...search, lexical } }))) });
    expect(rows.map(row => row.fullGoldWithLexical24)).toEqual([true, false, true, true]);
    expect(coverageSummary(rows).lexicalWouldRescue).toEqual(['rescued', 'alternative-rescue']);
  });

  it('cases without gold are listed with hasGold false and excluded from the denominator', async () => {
    const rows = await coverageRows({ cases: [fixtureCase('no-gold')], pipeline: pipeline(evidence()) });
    expect(rows[0]).toMatchObject({ id: 'no-gold', hasGold: false, alwaysCount: 1, retrievedCount: 1, evidenceBytes: 321, embeddingTokens: 7, elapsedMs: 12 });
    expect(rows[0].fullGoldSupplied).toBeUndefined();
    expect(rows[0].missing).toBeUndefined();
    expect(coverageSummary(rows)).toEqual({ goldCases: 0, fullGoldSupplied: 0, unavailable: 0, lexicalWouldRescue: [], maxEvidenceBytes: 321, medianElapsedMs: 12, embeddingTokens: 7 });
  });

  it('the summary reports unavailable resolutions separately', async () => {
    const rows = await coverageRows({ cases: ['unavailable', 'cancelled', 'searched'].map(id => fixtureCase(id, [ids[71]])), pipeline: pipeline(
      { kind: 'unavailable', reason: 'fiction', trace: trace({ search: undefined, embedding: { status: 'usage-unknown' }, elapsedMs: 4 }) },
      { kind: 'cancelled', trace: trace({ search: undefined, embedding: undefined, elapsedMs: 8 }) },
      { kind: 'unavailable', reason: 'selection-fiction', trace: trace({ elapsedMs: 30 }) },
    ) });
    for (const row of rows.slice(0, 2)) {
      expect(row).not.toHaveProperty('missing');
      expect(row).not.toHaveProperty('fullGoldSupplied');
      expect(row).not.toHaveProperty('fullGoldInDense64');
      expect(row).not.toHaveProperty('fullGoldWithLexical24');
      expect(row).not.toHaveProperty('embeddingTokens');
    }
    expect(rows[2]).toMatchObject({ fullGoldSupplied: false, missing: [{ id: ids[71], denseRank: 72, inAlways: false }] });
    expect(coverageSummary(rows)).toMatchObject({ goldCases: 3, fullGoldSupplied: 0, unavailable: 2, medianElapsedMs: 8, embeddingTokens: 7 });
    expect(coverageSummary([])).toEqual({ goldCases: 0, fullGoldSupplied: 0, unavailable: 0, lexicalWouldRescue: [], maxEvidenceBytes: 0, medianElapsedMs: 0, embeddingTokens: 0 });
  });

  it('passes multi-turn fixtures as verified history', async () => {
    const history = [{ question: 'Which imaginary orchard?', answer: 'The brass pear orchard.' }];
    const fake = pipeline(evidence());
    await coverageRows({ cases: [fixtureCase('history', [], { history })], pipeline: fake });
    expect(fake.resolve).toHaveBeenCalledWith({ question: fixtureCase('history').question, verifiedHistory: history });
  });

  it('rejects resolutions from a non-wide pipeline', async () => {
    await expect(coverageRows({ cases: [fixtureCase('jev')], pipeline: pipeline({ kind: 'fallback', reason: 'fiction', trace: trace({ strategy: 'jev' }) }) })).rejects.toThrow(/wide/i);
  });
});


describe('coverage CLI offline', () => {
  it('refuses Jev and the unset strategy before preparing a pipeline', async () => {
    const prepare = vi.fn();
    for (const env of [{}, { CVAI_RETRIEVAL_STRATEGY: 'jev' }])
      await expect(runCoverageCli(['fiction.json', 'new.json'], env, prepare)).rejects.toThrow('CVAI_RETRIEVAL_STRATEGY=wide');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('writes fictional results and refuses to overwrite before pipeline preparation', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fiction-coverage-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const casesFile = path.join(directory, 'cases.json');
      const output = path.join(directory, 'coverage.json');
      await writeFile(casesFile, JSON.stringify({ version: 1, cases: [fixtureCase('fiction-miss', [ids[71]])] }));
      const prepare = vi.fn(async () => pipeline(evidence()));
      await runCoverageCli([casesFile, output], { CVAI_RETRIEVAL_STRATEGY: 'wide' }, prepare);
      const receipt = await readFile(output, 'utf8');
      expect(JSON.parse(receipt)).toMatchObject({ ready: true, summary: { goldCases: 1, fullGoldSupplied: 0 }, rows: [{ id: 'fiction-miss', missing: [{ denseRank: 72 }] }] });
      expect(log).toHaveBeenCalledTimes(2);
      expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({ id: 'fiction-miss', resolution: 'evidence' });
      prepare.mockClear();
      await expect(runCoverageCli([casesFile, output], { CVAI_RETRIEVAL_STRATEGY: 'wide' }, prepare)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(prepare).not.toHaveBeenCalled();
      expect(await readFile(output, 'utf8')).toBe(receipt);
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
