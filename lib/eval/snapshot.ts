import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { stageDeployCorpus } from '../../scripts/stage-deploy-corpus';

/** A validated self-contained copy; cleanup owns only this newly allocated root. */
export async function withEvalSnapshot<T>(source: string, run: (directory: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(process.cwd(), '.stage-eval-'));
  try {
    const directory = path.join(root, 'corpus');
    await stageDeployCorpus(source, directory);
    return await run(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
