import { loadCorpus, resolveCorpusDir, type Corpus } from "./corpus";

// Cache only a successful load; a failed load is retried on the next call.
// Edits to the corpus take effect after a server restart.
let cached: Promise<Corpus> | null = null;

export function getCorpus(): Promise<Corpus> {
  if (!cached) {
    const p = loadCorpus(resolveCorpusDir());
    cached = p;
    p.catch(() => {
      if (cached === p) cached = null;
    });
  }
  return cached;
}

/** Test hook. */
export function resetCorpusCache(): void {
  cached = null;
}
