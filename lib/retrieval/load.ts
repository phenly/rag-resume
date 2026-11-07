import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadCorpus, type Corpus } from '../corpus';
import { extractRetrievalUnits, type ExportMetadata } from './extract';
import { EXTRACTOR_VERSION, TOKENIZER_VERSION, type IndexSnapshot } from './build-index';
import { validateRetrievalIndex, type RetrievalIndex } from './index-schema';
import { VOYAGE_EMBEDDING_CONFIG } from './voyage';

/** Uses the same title-derived supplemental IDs as the offline index builder. */
export async function loadRetrievalSnapshot(dir: string, loaded?: Corpus): Promise<IndexSnapshot> {
  const corpus = loaded ?? await loadCorpus(dir);
  const manifest = JSON.parse(await readFile(path.join(dir, 'corpus.json'), 'utf8'));
  if (typeof manifest.documentsFrom !== 'string') throw new Error('Retrieval requires exported metadata');
  const metadata = JSON.parse(await readFile(path.resolve(dir, manifest.documentsFrom), 'utf8')) as ExportMetadata;
  const supplemental = manifest.documents.map((item: { title: string }) => ({
    title: item.title, idPrefix: `supplemental-${createHash('sha256').update(item.title).digest('hex')}`,
  }));
  return { corpusVersion: corpus.version, extraction: extractRetrievalUnits(corpus, metadata, supplemental) };
}

export type RetrievalState = { status: 'ready' | 'missing' | 'stale' | 'invalid'; index?: RetrievalIndex };

/** Fail closed, returning only safe readiness labels. Failed reads are never cached. */
export async function inspectRetrievalIndex(dir: string, corpus: Corpus): Promise<RetrievalState> {
  let raw: string;
  try { raw = await readFile(path.join(dir, 'retrieval-index.json'), 'utf8'); }
  catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' }; }
  try {
    const index = validateRetrievalIndex(JSON.parse(raw));
    if (index.corpusVersion !== corpus.version) return { status: 'stale' };
    const snapshot = await loadRetrievalSnapshot(dir, corpus);
    validateRetrievalIndex(index, {
      corpusVersion: corpus.version, embedding: VOYAGE_EMBEDDING_CONFIG,
      extractorVersion: EXTRACTOR_VERSION, tokenizerVersion: TOKENIZER_VERSION,
      units: snapshot.extraction.units, globalRules: snapshot.extraction.globalRules,
    });
    return { status: 'ready', index };
  } catch { return { status: 'invalid' }; }
}

export async function requireFreshRetrievalIndex(dir: string, corpus?: Corpus): Promise<RetrievalIndex> {
  const state = await inspectRetrievalIndex(dir, corpus ?? await loadCorpus(dir));
  if (state.status !== 'ready' || !state.index) throw new Error(`Retrieval index is ${state.status}; rebuild before publishing`);
  return state.index;
}

/** Whole remains the default; selecting rag is an explicit operator decision. */
export function configuredApproach(): 'whole' | 'rag' {
  const value = process.env.CVAI_APPROACH ?? 'whole';
  if (value !== 'whole' && value !== 'rag') throw new Error('CVAI_APPROACH must be whole or rag');
  return value;
}

export function retrievalMetadata(state: RetrievalState) {
  const index = state.index;
  return index ? {
    status: state.status, corpusVersion: index.corpusVersion, indexVersion: index.indexVersion,
    schemaVersion: index.schemaVersion, embeddingModel: index.embedding.model, dimensions: index.embedding.dimensions,
  } : { status: state.status };
}
