import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadCorpus } from '../lib/corpus';
import type { ExportMetadata } from '../lib/retrieval/extract';
import { loadRetrievalSnapshot } from '../lib/retrieval/load';
import { assertIndexOutputIsNotSource, buildRetrievalIndex, writeIndexAtomically } from '../lib/retrieval/build-index';
import { createVoyageEmbedder, VOYAGE_EMBEDDING_CONFIG } from '../lib/retrieval/voyage';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--corpus') throw new Error('Usage: tsx --env-file=.env.local scripts/build-retrieval-index.ts --corpus <exported-corpus-directory>');
  const dir = await realpath(args[1]);
  // Only a fixed generated filename is writable. Never allow overwriting source files.
  const destination = path.join(dir, 'retrieval-index.json');
  const snapshot = async () => {
    const corpus = await loadCorpus(dir);
    const manifest = JSON.parse(await readFile(path.join(dir, 'corpus.json'), 'utf8'));
    if (typeof manifest.documentsFrom !== 'string') throw new Error('Index build requires an exported corpus manifest');
    const exportFile = path.resolve(dir, manifest.documentsFrom);
    const relative = path.relative(dir, await realpath(exportFile));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Export metadata must be inside corpus directory');
    const metadata = JSON.parse(await readFile(exportFile, 'utf8')) as ExportMetadata & { rules: string };
    const profile = JSON.parse(await readFile(path.resolve(dir, manifest.profile), 'utf8'));
    const sources = [path.join(dir, 'corpus.json'), exportFile,
      ...[manifest.profile, manifest.answerStyle, manifest.positioningNotes, profile.photo].filter(Boolean).map((p: string) => path.resolve(dir, p)),
      ...manifest.documents.map((item: { path: string }) => path.resolve(dir, item.path)),
      ...[metadata.rules, ...metadata.documents.map(item => item.path)].map(p => path.resolve(path.dirname(exportFile), p))];
    await assertIndexOutputIsNotSource(destination, sources);
    return loadRetrievalSnapshot(dir, corpus);
  };
  const before = await snapshot();
  let previous: unknown;
  try { previous = JSON.parse(await readFile(destination, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY is required');
  const index = await buildRetrievalIndex({ snapshot: before, embedding: VOYAGE_EMBEDDING_CONFIG, embedder: createVoyageEmbedder({ apiKey: key }), previous });
  await writeIndexAtomically(destination, index, async () => {
    const after = await snapshot();
    // Corpus hash excludes metadata; compare extraction too to catch a changed ID mapping.
    if (after.corpusVersion !== before.corpusVersion || JSON.stringify(after.extraction) !== JSON.stringify(before.extraction)) throw new Error('Corpus changed during index build; rerun');
  });
  console.log(JSON.stringify({ indexVersion: index.indexVersion, corpusVersion: index.corpusVersion, receipt: index.receipt }, null, 2));
}
main().catch(() => {
  // Avoid exposing corpus contents or credentials from arbitrary provider/parser errors.
  console.error('Retrieval index build failed. Check exported corpus, existing index, provider configuration and connectivity.');
  process.exitCode = 1;
});
