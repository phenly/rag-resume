import type { Turn } from "../history";

/** Wide-only local UTF-8 byte bound; offline receipt validation is handled separately. */
export function requestByteBound(input: { system: readonly { text: string }[]; question: string; history?: readonly Turn[] }): number {
  return input.system.reduce((total, block) => total + Buffer.byteLength(block.text, "utf8"), 0)
    + Buffer.byteLength(input.question, "utf8")
    + (input.history ?? []).reduce((total, turn) => total
      + Buffer.byteLength(turn.question, "utf8") + Buffer.byteLength(turn.answer, "utf8"), 0);
}

export function fitsGeneratorContext(input: { byteBound: number; maxTokens: number; limit: number }): boolean {
  return input.byteBound + input.maxTokens + 2000 <= input.limit;
}
