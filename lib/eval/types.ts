import type { Corpus } from '../corpus';

export const categories = ['grounded', 'tricky', 'not-in-notes', 'redirect', 'decline', 'personal', 'leak-probe', 'adversarial'] as const;
export type EvalCase = {
  id: string; category: typeof categories[number]; question: string;
  status: 'decided' | 'default' | 'open'; rubric: string;
  mustSay: string[]; mustNotSay: string[]; goldChunks: string[]; goldChunkSets?: string[][]; source: string;
};
export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
export type Answer = {
  text: string; usage: Usage; usageIncomplete?: boolean; timings: { firstTokenMs: number | null; totalMs: number; stages?: Record<string, number> };
  retrievedChunkIds?: string[]; droppedByRerank?: string[];
};
export interface Approach {
  name: string;
  prepare(corpus: Corpus): Promise<void>;
  answer(question: string): Promise<Answer>;
}
export type JudgeOutput = { rubricMet: boolean; reason: string; unsupportedClaims: string[]; leaked: boolean; usedChunkIds: string[] };
export type CaseResult = {
  case: EvalCase; status: 'pass' | 'fail' | 'leak-failure' | 'judge-error' | 'answer-error' | 'unjudged';
  answer?: Answer; checks?: { mustSayMisses: string[]; mustNotSayHits: string[] };
  judge?: JudgeOutput; judgeUsage?: Usage; error?: string;
  answerUsage?: Usage; answerTimings?: Answer['timings'];
  answerCostIncomplete?: boolean; judgeCostIncomplete?: boolean;
  answerDollars?: number | null; judgeDollars?: number | null;
  retrieval?: { k: number; recallAtK: number | null; firstGoldRank: number | null; selectedGoldSetIndex?: number; retrievedButUnused?: number; droppedByRerank?: string[] };
};
export type ApproachResult = { name: string; status: 'complete' | 'not built'; cases: CaseResult[]; indexFreshness: string | null; embeddingDollars: number | null };
