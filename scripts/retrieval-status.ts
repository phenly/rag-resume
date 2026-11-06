import { loadCorpus } from '../lib/corpus';
import { configuredApproach, requireFreshRetrievalIndex, retrievalMetadata } from '../lib/retrieval/load';

async function main() {
  const [dir, ...extra] = process.argv.slice(2);
  if (!dir || extra.length) throw new Error('Expected one corpus directory');
  const corpus = await loadCorpus(dir);
  const index = await requireFreshRetrievalIndex(dir, corpus);
  console.log(JSON.stringify({ version: corpus.version, approach: configuredApproach(), retrieval: retrievalMetadata({ status: 'ready', index }) }));
}
main().catch(() => { console.error('Retrieval freshness validation failed; build and stage a matching corpus/index pair.'); process.exitCode = 1; });
