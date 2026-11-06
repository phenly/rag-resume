import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCorpus } from '../lib/corpus';
import { loadRetrievalSnapshot, requireFreshRetrievalIndex } from '../lib/retrieval/load';

const exists = async (p: string) => lstat(p).then(() => true, (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
const inside = (parent: string, child: string) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

/** Validate the complete pair before touching the previous staged snapshot. */
export async function stageDeployCorpus(source: string, output: string, options: { defaultOutput?: string; beforeFreshCheck?: () => Promise<void> } = {}): Promise<void> {
  const src = await realpath(source);
  const out = path.resolve(output);
  await mkdir(path.dirname(out), { recursive: true });
  const physicalOut = path.join(await realpath(path.dirname(out)), path.basename(out));
  if (inside(src, physicalOut) || inside(physicalOut, src)) throw new Error('Refusing staging output: overlaps source corpus');
  const hadOutput = await exists(out);
  if (hadOutput) {
    const info = await lstat(out);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing staging output: not a regular directory');
    const isDefault = options.defaultOutput !== undefined && physicalOut === path.resolve(options.defaultOutput);
    if (!isDefault) {
      if (!(await exists(path.join(out, 'corpus.json')))) throw new Error('Refusing staging output: missing corpus.json');
      for (const file of await readdir(out, { withFileTypes: true })) {
        if (file.isDirectory() || file.isSymbolicLink() || (file.name.endsWith('.md') && !/^(doc-\d+|answer-style|positioning-notes|global-rules)\.md$/.test(file.name))) throw new Error('Refusing staging output: unrelated contents');
      }
    }
  }
  const before = await loadRetrievalSnapshot(src);
  const sourceIndex = await requireFreshRetrievalIndex(src);
  const temp = path.join(path.dirname(out), `.stage-${randomUUID()}`);
  const backup = path.join(path.dirname(out), `.stage-backup-${randomUUID()}`);
  let backedUp = false;
  try {
    await mkdir(temp, { mode: 0o700 });
    const manifest = JSON.parse(await readFile(path.join(src, 'corpus.json'), 'utf8'));
    const copy = async (rel: string, name: string, base = src) => {
      await copyFile(path.resolve(base, rel), path.join(temp, name));
      return name;
    };
    manifest.profile = await copy(manifest.profile, 'profile.json');
    manifest.positioningNotes = await copy(manifest.positioningNotes, 'positioning-notes.md');
    if (manifest.answerStyle !== undefined) manifest.answerStyle = await copy(manifest.answerStyle, 'answer-style.md');
    let count = 0;
    const copyDocuments = async (docs: { title: string; path: string }[], base: string) => {
      const copied = [];
      for (const doc of docs) copied.push({ title: doc.title, path: await copy(doc.path, `doc-${++count}.md`, base) });
      return copied;
    };
    manifest.documents = await copyDocuments(manifest.documents, src);
    const exportFile = path.resolve(src, manifest.documentsFrom);
    const metadata = JSON.parse(await readFile(exportFile, 'utf8'));
    metadata.documents = await copyDocuments(metadata.documents, path.dirname(exportFile));
    metadata.rules = await copy(metadata.rules, 'global-rules.md', path.dirname(exportFile));
    manifest.documentsFrom = 'bot-export.json';
    await writeFile(path.join(temp, manifest.documentsFrom), JSON.stringify(metadata) + '\n');
    const profile = JSON.parse(await readFile(path.join(temp, 'profile.json'), 'utf8'));
    if (profile.photo) {
      profile.photo = await copy(profile.photo, `photo${path.extname(profile.photo)}`);
      await writeFile(path.join(temp, 'profile.json'), JSON.stringify(profile) + '\n');
    }
    await writeFile(path.join(temp, 'corpus.json'), JSON.stringify(manifest) + '\n');
    await copy('retrieval-index.json', 'retrieval-index.json');
    const stagedCorpus = await loadCorpus(temp);
    const stagedIndex = await requireFreshRetrievalIndex(temp, stagedCorpus);
    if (stagedCorpus.version !== before.corpusVersion || stagedIndex.indexVersion !== sourceIndex.indexVersion) throw new Error('Corpus/index changed during staging');
    await options.beforeFreshCheck?.();
    const after = await loadRetrievalSnapshot(src);
    const afterIndex = await requireFreshRetrievalIndex(src);
    if (JSON.stringify(before) !== JSON.stringify(after) || afterIndex.indexVersion !== sourceIndex.indexVersion) throw new Error('Corpus/index changed during staging');
    if (hadOutput) { await rename(out, backup); backedUp = true; }
    try { await rename(temp, out); }
    catch (error) { if (backedUp) { await rename(backup, out); backedUp = false; } throw error; }
    if (backedUp) { await rm(backup, { recursive: true }); backedUp = false; }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [src, out = path.resolve('deploy-corpus'), ...extra] = process.argv.slice(2);
  if (!src || extra.length) { console.error('Usage: stage-deploy-corpus.sh <corpus-dir> [output-dir]'); process.exitCode = 1; }
  else stageDeployCorpus(src, out, { defaultOutput: path.resolve('deploy-corpus') }).then(() => console.log('Staged validated corpus and retrieval index.'), () => { console.error('Refusing staging output: check source/index freshness, output safety and source consistency. Previous snapshot preserved.'); process.exitCode = 1; });
}
