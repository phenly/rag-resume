import { readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { retrievalCorpusFixture as stageFixture } from './fixtures/retrieval-corpus';
import { stageDeployCorpus } from '../scripts/stage-deploy-corpus';
import { requireFreshRetrievalIndex } from '../lib/retrieval/load';


describe('validated corpus/index staging', () => {
  it('flattens a complete fresh pair with unchanged corpus/index identity', async () => {
    const f = await stageFixture();
    await stageDeployCorpus(f.dir, f.out);
    expect((await requireFreshRetrievalIndex(f.out)).indexVersion).toBe(f.index.indexVersion);
    const manifest = JSON.parse(await readFile(path.join(f.out, 'corpus.json'), 'utf8'));
    expect(manifest.documentsFrom).toBe('bot-export.json');
  });
  it('replaces the configured default output and previous staging outputs', async () => {
    const f = await stageFixture();
    await f.put(f.out, 'stale.txt', 'old');
    await stageDeployCorpus(f.dir, f.out, { defaultOutput: f.out });
    expect(await f.exists(path.join(f.out, 'stale.txt'))).toBe(false);
    await f.put(f.out, 'doc-99.md', 'stale doc');
    await stageDeployCorpus(f.dir, f.out);
    expect(await f.exists(path.join(f.out, 'doc-99.md'))).toBe(false);
  });
  it.each([
    ['unrelated files', { 'notes.txt': 'mine' }],
    ['unrelated markdown', { 'corpus.json': '{}', 'diary.md': 'mine' }],
    ['subdirectory', { 'corpus.json': '{}', 'sub/inner.txt': 'mine' }],
  ])('refuses output with %s without removing it', async (_name, files) => {
    const f = await stageFixture();
    await f.put(f.out, '.keep', '');
    for (const [file, value] of Object.entries(files)) await f.put(f.out, file, value);
    await expect(stageDeployCorpus(f.dir, f.out)).rejects.toThrow('Refusing');
    expect(await f.exists(path.join(f.out, '.keep'))).toBe(true);
  });
  it('refuses source aliases, nested output, ancestor output and output symlinks', async () => {
    const f = await stageFixture();
    for (const out of [f.dir, `${f.dir}/../corpus`, path.join(f.dir, 'nested'), path.dirname(f.dir)]) {
      await expect(stageDeployCorpus(f.dir, out)).rejects.toThrow('Refusing');
    }
    await symlink(f.dir, f.out);
    await expect(stageDeployCorpus(f.dir, f.out)).rejects.toThrow('Refusing');
    expect(await f.exists(path.join(f.dir, 'corpus.json'))).toBe(true);
  });
  it('preserves previous staged pair when the index is stale or invalid', async () => {
    const f = await stageFixture();
    await stageDeployCorpus(f.dir, f.out);
    const old = await readFile(path.join(f.out, 'retrieval-index.json'), 'utf8');
    await f.put(f.dir, f.manifest.positioningNotes, 'Changed positioning');
    await expect(stageDeployCorpus(f.dir, f.out)).rejects.toThrow();
    expect(await readFile(path.join(f.out, 'retrieval-index.json'), 'utf8')).toBe(old);
    await f.put(f.dir, 'retrieval-index.json', '{}');
    await expect(stageDeployCorpus(f.dir, f.out)).rejects.toThrow();
    expect(await readFile(path.join(f.out, 'retrieval-index.json'), 'utf8')).toBe(old);
  });
  it('preserves previous staged pair when source changes during staging', async () => {
    const f = await stageFixture();
    await stageDeployCorpus(f.dir, f.out);
    const old = await readFile(path.join(f.out, 'retrieval-index.json'), 'utf8');
    await expect(stageDeployCorpus(f.dir, f.out, { beforeFreshCheck: async () => {
      await writeFile(path.join(f.dir, f.manifest.positioningNotes), 'Changed during copy');
    } })).rejects.toThrow();
    expect(await readFile(path.join(f.out, 'retrieval-index.json'), 'utf8')).toBe(old);
  });
});
