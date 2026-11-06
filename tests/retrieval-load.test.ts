import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { corpusFixture } from './fixtures/corpus';
import { loadCorpus } from '../lib/corpus';
import { buildRetrievalIndex } from '../lib/retrieval/build-index';
import { sealRetrievalIndex } from '../lib/retrieval/index-schema';
import { configuredApproach, inspectRetrievalIndex, loadRetrievalSnapshot, requireFreshRetrievalIndex, retrievalMetadata } from '../lib/retrieval/load';
import { VOYAGE_EMBEDDING_CONFIG } from '../lib/retrieval/voyage';

async function fixture() {
  const f = await corpusFixture();
  const chunks = f.exported.documents.map((doc, i) => ({ id: `EX-${i}`, title: 'Scope', file: doc.title, hash: 'a'.repeat(64) }));
  await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks }));
  for (const doc of f.exported.documents) await f.put(f.sourceDir, doc.path, `# ${doc.title}\n\n### Scope\nBuilt fictional widgets.\n`);
  const corpus = await loadCorpus(f.dir);
  const index = await buildRetrievalIndex({ snapshot: await loadRetrievalSnapshot(f.dir, corpus), embedding: VOYAGE_EMBEDDING_CONFIG,
    embedder: { embed: async texts => ({ vectors: texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)), inputTokens: 0 }) } });
  const save = (value: unknown) => writeFile(path.join(f.dir, 'retrieval-index.json'), JSON.stringify(value));
  return { ...f, corpus, index, save };
}

describe('retrieval readiness', () => {
  it('requires complete current coverage and exposes only safe metadata', async () => {
    const f = await fixture();
    expect(await inspectRetrievalIndex(f.dir, f.corpus)).toEqual({ status: 'missing' });
    await f.save(f.index);
    const state = await inspectRetrievalIndex(f.dir, f.corpus);
    expect(state.status).toBe('ready');
    expect(await requireFreshRetrievalIndex(f.dir)).toEqual(f.index);
    expect(retrievalMetadata(state)).toEqual({ status: 'ready', corpusVersion: f.corpus.version, indexVersion: f.index.indexVersion,
      schemaVersion: 1, embeddingModel: 'voyage-4-large', dimensions: 1024 });
    await f.put(f.dir, f.manifest.positioningNotes, 'A changed style envelope.');
    expect(await inspectRetrievalIndex(f.dir, await loadCorpus(f.dir))).toEqual({ status: 'stale' });
    await expect(requireFreshRetrievalIndex(f.dir)).rejects.toThrow('stale');
  });
  it('rejects checksum, metadata and embedding mismatches and retries after repair', async () => {
    const f = await fixture();
    await f.save({ ...f.index, indexVersion: 'b'.repeat(64) });
    expect(await inspectRetrievalIndex(f.dir, f.corpus)).toEqual({ status: 'invalid' });
    await f.save(sealRetrievalIndex({ ...f.index, embedding: { ...f.index.embedding, model: 'other' } }));
    expect(await inspectRetrievalIndex(f.dir, f.corpus)).toEqual({ status: 'invalid' });
    await f.save(f.index);
    const chunks = f.exported.documents.map((doc, i) => ({ id: `OTHER-${i}`, title: 'Scope', file: doc.title, hash: 'a'.repeat(64) }));
    await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks }));
    expect(await inspectRetrievalIndex(f.dir, f.corpus)).toEqual({ status: 'invalid' });
    await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks: f.index.units.filter(u => u.kind === 'entry').map(u => ({ id: u.id, title: u.title, file: u.document, hash: u.exporterHash })) }));
    expect((await inspectRetrievalIndex(f.dir, f.corpus)).status).toBe('ready');
  });
  it('keeps serving mode whole until the runner is integrated', () => {
    try {
      vi.stubEnv('CVAI_APPROACH', 'whole'); expect(configuredApproach()).toBe('whole');
      vi.stubEnv('CVAI_APPROACH', 'rag'); expect(() => configuredApproach()).toThrow();
      vi.stubEnv('CVAI_APPROACH', 'typo'); expect(() => configuredApproach()).toThrow();
    } finally { vi.unstubAllEnvs(); }
  });
});
