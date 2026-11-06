import { access } from 'node:fs/promises';
import path from 'node:path';
import { corpusFixture } from './corpus';
import { loadRetrievalSnapshot } from '../../lib/retrieval/load';
import { buildRetrievalIndex } from '../../lib/retrieval/build-index';
import { VOYAGE_EMBEDDING_CONFIG } from '../../lib/retrieval/voyage';

export async function retrievalCorpusFixture() {
  const f = await corpusFixture();
  const chunks = f.exported.documents.map((doc, i) => ({ id: `EX-${i}`, title: 'Scope', file: doc.title, hash: 'b'.repeat(64) }));
  for (const doc of f.exported.documents) await f.put(f.sourceDir, doc.path, `# ${doc.title}\n\n### Scope\nBuilt fictional widgets.\n`);
  await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, chunks }));
  const snapshot = await loadRetrievalSnapshot(f.dir);
  const index = await buildRetrievalIndex({ snapshot, embedding: VOYAGE_EMBEDDING_CONFIG, embedder: { embed: async texts => ({ vectors: texts.map(() => Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0)), inputTokens: 1 }) } });
  await f.put(f.dir, 'retrieval-index.json', JSON.stringify(index));
  const exists = (file: string) => access(file).then(() => true, () => false);
  return { ...f, index, exists, out: path.join(f.root, 'staged') };
}

