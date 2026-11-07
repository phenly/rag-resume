import type { Corpus } from '../corpus';
import type { RagResolution } from '../retrieval/pipeline';

export const categories = ['grounded', 'tricky', 'not-in-notes', 'redirect', 'decline', 'personal', 'leak-probe', 'adversarial'] as const;
export type EvalCase = {
  id: string; category: typeof categories[number]; question: string;
  status: 'decided' | 'default' | 'open'; rubric: string;
  history?: { question: string; answer: string }[];
  mustSay: string[]; mustNotSay: string[]; goldChunks: string[]; goldChunkSets?: string[][]; source: string;
};
export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
export type Answer = {
  text: string; usage: Usage; usageIncomplete?: boolean; timings: { firstTokenMs: number | null; totalMs: number; stages?: Record<string, number> };
  retrievedChunkIds?: string[]; droppedByRerank?: string[];
  /** Exact rendered generation system, retained only in private eval receipts. */
  suppliedEvidence?: string;
  resolvedModel?: string;
  resolvedModels?: string[];
  retrievalTrace?: RagResolution['trace'];
  effectiveApproach?: 'rag' | 'whole' | 'deterministic';
  actualContext?: 'whole-corpus' | 'selected-evidence' | 'none';
  generationEligibility?: { eligible: boolean; inputTokens?: number; reason?: string };
};
export interface Approach {
  name: string;
  prepare(corpus: Corpus): Promise<void>;
  answer(question: string, history?: readonly { question: string; answer: string }[]): Promise<Answer>;
}
export type RetrievalMetrics = { k: number; recallAtK: number | null; firstGoldRank: number | null; selectedGoldSetIndex?: number };
export type JudgeOutput = { contextGrounding?: 'assessed' | 'unavailable'; unsupportedInContextClaims?: string[]; rubricMet: boolean; reason: string; unsupportedClaims: string[]; leaked: boolean; usedChunkIds: string[] };
export type CaseResult = {
  case: EvalCase; status: 'pass' | 'fail' | 'leak-failure' | 'judge-error' | 'answer-error' | 'unjudged';
  comparisonEligible?: boolean;
  answer?: Answer; checks?: { mustSayMisses: string[]; mustNotSayHits: string[] };
  judge?: JudgeOutput; judgeUsage?: Usage; error?: string;
  answerUsage?: Usage; answerTimings?: Answer['timings'];
  answerCostIncomplete?: boolean; judgeCostIncomplete?: boolean;
  answerDollars?: number | null; judgeDollars?: number | null;
  retrievalDollars?: number | null; retrievalKnownDollars?: number; retrievalCostIncomplete?: boolean;
  retrievalTrace?: RagResolution['trace'];
  retrievalLosses?: Partial<Record<'relevance' | 'top-eight' | 'token-budget', string[]>>;
  retrievalStages?: Partial<Record<'dense' | 'lexical' | 'fused' | 'filtered' | 'reranked' | 'selected', RetrievalMetrics>>;
  retrieval?: { k: number; recallAtK: number | null; firstGoldRank: number | null; selectedGoldSetIndex?: number; retrievedButUnused?: number; droppedByRerank?: string[] };
};
export type ApproachResult = { name: string; status: 'complete' | 'not built'; cases: CaseResult[]; indexFreshness: string | null; embeddingDollars: number | null };
