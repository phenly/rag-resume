import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extractRetrievalUnits } from '../lib/retrieval/extract';
import { assertIndexOutputIsNotSource, buildRetrievalIndex, writeIndexAtomically } from '../lib/retrieval/build-index';
import { VOYAGE_EMBEDDING_CONFIG } from '../lib/retrieval/voyage';

function snapshot(text = 'Made fictional widgets.', version = 'a'.repeat(64)) {
  return { corpusVersion: version, extraction: extractRetrievalUnits({ documents: [{ title: 'Example', text: `# Example\n\n### Scope\n${text}\n` }] }, { documents: [{ title: 'Example', path: 'example.md' }], chunks: [{ id: 'EX-SCOPE', title: 'Scope', file: 'Example', hash: 'b'.repeat(64) }] }, []) };
}
const embedder = () => ({ embed: vi.fn(async (texts: readonly string[]) => ({ vectors: texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)), inputTokens: texts.length * 10 })) });
const build = (input = snapshot(), previous?: unknown, provider = embedder()) => buildRetrievalIndex({ snapshot: input, previous, embedding: VOYAGE_EMBEDDING_CONFIG, embedder: provider });

describe('offline index builder', () => {
  it('embeds fresh content and accounts for usage and cost', async () => {
    const provider = embedder();
    const index = await build(snapshot(), undefined, provider);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(index.receipt).toMatchObject({ embeddedUnitCount: 1, reusedUnitCount: 0, providerTokens: 10, costUsd: 0.0000012 });
  });
  it('reuses exact factual text across corpus/instruction changes with a fresh envelope', async () => {
    const initial = snapshot('Made fictional widgets.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: Be concise.');
    const first = await build(initial);
    const changed = snapshot('Made fictional widgets.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: Keep the answer brief.', 'c'.repeat(64));
    const provider = embedder();
    const second = await build(changed, first, provider);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(second.receipt.reusedUnitCount).toBe(1);
    expect(second.indexVersion).not.toBe(first.indexVersion);
    expect(second.units[0].promptText).toContain('Keep the answer brief');
    const third = await build(changed, second, provider);
    expect(third.indexVersion).toBe(second.indexVersion);
  });
  it('embeds changed factual text and rejects corruption/config mismatch', async () => {
    const first = await build();
    const provider = embedder();
    const next = await build(snapshot('Built different fictional widgets.'), first, provider);
    expect(next.receipt.embeddedUnitCount).toBe(1);
    const corrupt = structuredClone(first); corrupt.units[0].vector[0] = 2;
    await expect(build(snapshot(), corrupt)).rejects.toThrow();
    const wrong = structuredClone(first); wrong.embedding.model = 'wrong';
    await expect(build(snapshot(), wrong)).rejects.toThrow();
  });
  it('rejects oversize inputs before any paid requests and honors cancellation', async () => {
    const provider = embedder();
    await expect(build(snapshot('a'.repeat(8001)), undefined, provider)).rejects.toThrow('budget');
    expect(provider.embed).not.toHaveBeenCalled();
    await expect(buildRetrievalIndex({ snapshot: snapshot(), embedding: VOYAGE_EMBEDDING_CONFIG, embedder: provider, signal: AbortSignal.abort() })).rejects.toThrow();
  });
  it('accepts reordered equivalent config and rejects source/output aliases', async () => {
    const config = Object.fromEntries(Object.entries(VOYAGE_EMBEDDING_CONFIG).reverse()) as typeof VOYAGE_EMBEDDING_CONFIG;
    await expect(buildRetrievalIndex({ snapshot: snapshot(), embedding: config, embedder: embedder() })).resolves.toBeDefined();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'retrieval-path-'));
    try {
      const destination = path.join(dir, 'retrieval-index.json');
      const source = path.join(dir, 'source.json');
      await writeFile(source, 'fictional source');
      await expect(assertIndexOutputIsNotSource(destination, [source])).resolves.toBeUndefined();
      await symlink(source, destination);
      await expect(assertIndexOutputIsNotSource(destination, [source])).rejects.toThrow('collides');
      await expect(assertIndexOutputIsNotSource(source, [source])).rejects.toThrow('collides');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves the previous artifact on provider failure or freshness failure', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'retrieval-build-'));
    const destination = path.join(dir, 'retrieval-index.json');
    try {
      await writeFile(destination, 'previous');
      const provider = { embed: vi.fn(async () => { throw new Error('provider failure'); }) };
      await expect(build(snapshot(), undefined, provider)).rejects.toThrow('provider failure');
      const index = await build();
      await expect(writeIndexAtomically(destination, index, async () => { throw new Error('stale'); })).rejects.toThrow('stale');
      expect(await readFile(destination, 'utf8')).toBe('previous');
      expect(await readdir(dir)).toEqual(['retrieval-index.json']);
      await writeIndexAtomically(destination, index, async () => {});
      expect(JSON.parse(await readFile(destination, 'utf8')).indexVersion).toBe(index.indexVersion);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
