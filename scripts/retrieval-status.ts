import { loadCorpus } from '../lib/corpus';
import { configuredApproach, configuredStrategy, requireFreshRetrievalIndex, retrievalMetadata } from '../lib/retrieval/load';

import { RETRIEVAL_CONFIG_VERSION } from '../lib/retrieval/pipeline';

import { retrievalDetail } from '../lib/retrieval/detail';

async function main() {
  const [dir, ...extra] = process.argv.slice(2);
  if (!dir || dir.startsWith('--') || (extra.length && (extra.length !== 1 || extra[0] !== '--detail'))) {
    throw new Error('Expected a corpus directory followed by optional --detail');
  }
  const corpus = await loadCorpus(dir);
  const index = await requireFreshRetrievalIndex(dir, corpus);
  let detail;
  if (extra[0] === '--detail') {
    detail = retrievalDetail({ strategy: configuredStrategy(), index });
  }
  console.log(JSON.stringify({ version: corpus.version, approach: configuredApproach(), retrievalConfigVersion: RETRIEVAL_CONFIG_VERSION, retrieval: retrievalMetadata({ status: 'ready', index }), ...(detail ? { detail } : {}) }));
}
main().catch(() => { console.error('Retrieval freshness validation failed; build and stage a matching corpus/index pair.'); process.exitCode = 1; });
