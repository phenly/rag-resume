import type { RetrievalIndex } from './index-schema';
import type { RetrievalStrategy } from './load';
import { activeRetrievalConfigVersion } from './production';
import { isAlwaysSupplied, WIDE_SELECTION_CONFIG } from './wide-select';

export function retrievalDetail(input: {
  strategy: RetrievalStrategy;
  index: Pick<RetrievalIndex, 'units'> | null;
}): {
  strategy: RetrievalStrategy;
  retrievalConfigVersion: string;
  alwaysSuppliedCount: number | null;
  overviewPresent: boolean | null;
} {
  const always = input.index?.units.filter(isAlwaysSupplied);
  return {
    strategy: input.strategy,
    retrievalConfigVersion: activeRetrievalConfigVersion(input.strategy),
    alwaysSuppliedCount: always?.length ?? null,
    overviewPresent: always?.some(unit => unit.kind === 'entry'
      && unit.document === WIDE_SELECTION_CONFIG.alwaysDocumentTitle) ?? null,
  };
}
