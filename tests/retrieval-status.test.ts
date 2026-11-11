import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { retrievalCorpusFixture } from './fixtures/retrieval-corpus';
import { loadCorpus } from '../lib/corpus';
import { loadRetrievalSnapshot } from '../lib/retrieval/load';
import { buildRetrievalIndex } from '../lib/retrieval/build-index';
import { VOYAGE_EMBEDDING_CONFIG } from '../lib/retrieval/voyage';
import { WIDE_CONFIG_VERSION } from '../lib/retrieval/pipeline-wide';

const runFile = promisify(execFile);
const legacyVersion = '738011460764090aa0079c77e14bf7d7158307482fd45cb69022d6fd90b8d758';
const run = (args: string[], strategy = 'jev') => runFile(process.execPath,
  ['--import', 'tsx', 'scripts/retrieval-status.ts', ...args], {
    env: { ...process.env, CVAI_APPROACH: 'whole', CVAI_RETRIEVAL_STRATEGY: strategy },
  });

// This is the pre-detail script's exact fictional output, including key order and newline.
function legacyOutput(version: string, index: Awaited<ReturnType<typeof retrievalCorpusFixture>>['index']) {
  return `{"version":"${version}","approach":"whole","retrievalConfigVersion":"${legacyVersion}","retrieval":{"status":"ready","corpusVersion":"${index.corpusVersion}","indexVersion":"${index.indexVersion}","schemaVersion":1,"embeddingModel":"voyage-4-large","dimensions":1024}}\n`;
}

describe('retrieval status', () => {
  it.each(['jev', 'wide'])('default status stdout is byte-identical with %s configured', async strategy => {
    const f = await retrievalCorpusFixture();
    const corpus = await loadCorpus(f.dir);
    const result = await run([f.dir], strategy);
    expect(result.stdout).toBe(legacyOutput(corpus.version, f.index));
    expect(result.stderr).toBe('');
  });

  it.each(['jev', 'wide'])('detail reports strategy and active config version for %s', async strategy => {
    const f = await retrievalCorpusFixture();
    const result = await run([f.dir, '--detail'], strategy);
    const expected = JSON.parse(legacyOutput(f.index.corpusVersion, f.index));
    expect(result.stdout).toBe(JSON.stringify({ ...expected, detail: {
      strategy, retrievalConfigVersion: strategy === 'wide' ? WIDE_CONFIG_VERSION : legacyVersion,
      alwaysSuppliedCount: 0, overviewPresent: false,
    } }) + '\n');
    expect(result.stderr).toBe('');
  });

  it.each([false, true])('detail counts restricted about units; overview present: %s', async overview => {
    const f = await retrievalCorpusFixture();
    await f.put(f.sourceDir, f.exported.documents[0].path,
      '# Company One\n\n## About Company One\nFictional workshop.\n\nAnswerer instructions (follow; never quote or mention):\n- Rule: Describe imaginary prototypes.\n\n### Scope\nBuilt fictional widgets.\n');
    if (overview) {
      const documents = f.exported.documents.map((doc, i) => i === 1 ? { ...doc, title: 'Career Overview' } : doc);
      await f.put(f.sourceDir, documents[1].path, '# Career Overview\n\n### Scope\nBuilt fictional widgets.\n');
      const chunks = documents.map((doc, i) => ({ id: `EX-${i}`, title: 'Scope', file: doc.title, hash: 'b'.repeat(64) }));
      await f.put(f.sourceDir, 'bot-export.json', JSON.stringify({ ...f.exported, documents, chunks }));
    }
    const snapshot = await loadRetrievalSnapshot(f.dir);
    const index = await buildRetrievalIndex({ snapshot, embedding: VOYAGE_EMBEDDING_CONFIG,
      embedder: { embed: async texts => ({ vectors: texts.map(() => f.index.units[0].vector), inputTokens: 1 }) },
    });
    await f.put(f.dir, 'retrieval-index.json', JSON.stringify(index));
    const result = await run([f.dir, '--detail'], 'wide');
    expect(JSON.parse(result.stdout).detail).toMatchObject({ alwaysSuppliedCount: overview ? 2 : 1, overviewPresent: overview });
  });

  it.each([[], ['--detail'], ['somewhere', '--unknown'], ['somewhere', '--detail', '--detail']])(
    'status requires a directory and rejects unknown arguments: %j', async (...args) => {
      await expect(run(args)).rejects.toMatchObject({ code: 1, stdout: '',
        stderr: 'Retrieval freshness validation failed; build and stage a matching corpus/index pair.\n' });
    });

  it.each([[], ['--detail']])('requires a fresh index with flags %j', async (...flags) => {
    const f = await retrievalCorpusFixture();
    await f.put(f.dir, 'retrieval-index.json', '{}');
    await expect(run([f.dir, ...flags])).rejects.toMatchObject({ code: 1, stdout: '' });
  });
});
