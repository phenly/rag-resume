import { expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as prompt from '../lib/prompt';
import { isMainModule, preflightResolution } from '../scripts/rag-preflight';
import { corpusFixture } from './fixtures/corpus';
import { loadCorpus } from '../lib/corpus';

const modulePath = realpathSync(fileURLToPath(new URL('../scripts/rag-preflight.ts', import.meta.url)));
const moduleUrl = pathToFileURL(modulePath).href;

it('recognizes the module own real path as main', () => {
  expect(isMainModule(moduleUrl, modulePath)).toBe(true);
});

it('recognizes a symlink to the module as main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-preflight-main-'));
  try {
    const link = join(dir, 'preflight.ts');
    symlinkSync(modulePath, link);
    expect(isMainModule(moduleUrl, link)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('does not recognize another file as main', () => {
  expect(isMainModule(moduleUrl, fileURLToPath(import.meta.url))).toBe(false);
});

it('does not recognize an undefined argv path as main', () => {
  expect(isMainModule(moduleUrl, undefined)).toBe(false);
});

it('does not recognize a nonexistent path as main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rag-preflight-missing-'));
  try {
    expect(isMainModule(moduleUrl, join(dir, 'missing.ts'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('unavailable records kind and trace without whole prompt construction or counting', async () => {
  const corpus = await loadCorpus((await corpusFixture()).dir); const whole = vi.spyOn(prompt, 'buildSystemPrompt'); const createGuard = vi.fn();
  const trace = { retrievalConfigVersion: 'fictional', elapsedMs: 0, stages: {} };
  try {
    expect(await preflightResolution({ id: 'F1', question: 'lantern?' }, { kind: 'unavailable', reason: 'index-missing', trace }, corpus, createGuard))
      .toEqual({ id: 'F1', kind: 'unavailable', trace, eligibility: null, countMs: null });
    expect(whole).not.toHaveBeenCalled(); expect(createGuard).not.toHaveBeenCalled();
  } finally { whole.mockRestore(); }
});

it('refuses the wide strategy, whose prompt layout preflight does not measure', async () => {
  const { assertPreflightStrategy } = await import('../scripts/rag-preflight');
  expect(() => assertPreflightStrategy('wide')).toThrow(/jev/i);
  expect(() => assertPreflightStrategy('jev')).not.toThrow();
});
