import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { withEvalSnapshot } from '../lib/eval/snapshot';
import { loadCorpus } from '../lib/corpus';
import { chunkIndex } from '../lib/eval/corpus';
import { requireFreshRetrievalIndex } from '../lib/retrieval/load';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';

it('isolates corpus, metadata and index from edits after the snapshot, then cleans its own copy', async () => {
  const fixture = await retrievalCorpusFixture();
  const original = await loadCorpus(fixture.dir);
  let snapshotRoot = '';
  await withEvalSnapshot(fixture.dir, async directory => {
    snapshotRoot = path.dirname(directory);
    const before = await loadCorpus(directory);
    const metadata = await chunkIndex(directory, before);
    const index = await readFile(path.join(directory, 'retrieval-index.json'), 'utf8');
    await fixture.put(fixture.dir, fixture.manifest.positioningNotes, 'A new rule after snapshot.');
    await fixture.put(fixture.sourceDir, fixture.exported.documents[0].path, 'Changed source document.');
    await fixture.put(fixture.sourceDir, 'bot-export.json', 'invalid now');
    await fixture.put(fixture.dir, 'retrieval-index.json', 'invalid now');
    expect(before.version).toBe(original.version);
    expect((await loadCorpus(directory)).version).toBe(original.version);
    expect(await chunkIndex(directory, before)).toEqual(metadata);
    expect(await readFile(path.join(directory, 'retrieval-index.json'), 'utf8')).toBe(index);
    expect((await requireFreshRetrievalIndex(directory)).indexVersion).toBe(fixture.index.indexVersion);
  });
  await expect(access(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(fixture.dir, 'retrieval-index.json'), 'utf8')).toBe('invalid now');
});

it('cleans only its snapshot when evaluation throws', async () => {
  const fixture = await retrievalCorpusFixture();
  let snapshotRoot = '';
  await expect(withEvalSnapshot(fixture.dir, async directory => {
    snapshotRoot = path.dirname(directory);
    throw new Error('fictional evaluation failure');
  })).rejects.toThrow('fictional evaluation failure');
  await expect(access(snapshotRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await loadCorpus(fixture.dir)).profile.name).toBe('Pat Example');
});

it('rejects stale source before invoking evaluation and removes its temporary root', async () => {
  const fixture = await retrievalCorpusFixture();
  const roots = () => readdir(process.cwd()).then(names => names.filter(name => name.startsWith('.stage-eval-')).sort());
  const before = await roots();
  await fixture.put(fixture.dir, fixture.manifest.positioningNotes, 'Changed without rebuilding index.');
  const run = vi.fn();
  await expect(withEvalSnapshot(fixture.dir, run)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(await roots()).toEqual(before);
});
