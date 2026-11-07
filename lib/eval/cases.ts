import { readFile } from 'node:fs/promises';
import { categories, type EvalCase } from './types';
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS, type Turn } from '../history';

/** Trusted offline fixtures, never visitor authentication. Snapshot before provider work. */
export function evalHistory(value: unknown): Turn[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_HISTORY_TURNS || Array.from(value).some(turn =>
    !turn || typeof turn !== 'object' || Array.isArray(turn)
    || typeof turn.question !== 'string' || typeof turn.answer !== 'string'
    || Object.keys(turn).some(key => key !== 'question' && key !== 'answer')))
    throw new Error('Invalid eval history: expected at most six question/answer fixture turns');
  if (value.reduce((sum, turn) => sum + turn.question.length + turn.answer.length, 0) > MAX_HISTORY_CHARS)
    throw new Error('Invalid eval history: character limit exceeded');
  return value.map(turn => ({ question: turn.question, answer: turn.answer, sig: '' }));
}

export function validateCases(value: unknown): { version: 1; cases: EvalCase[] } {
  const fail = (message: string): never => { throw new Error(`Invalid eval cases: ${message}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('expected { version: 1, cases: [] }');
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.cases)) return fail('version must be 1 and cases must be an array');
  const ids = new Set<string>();
  root.cases.forEach((v: unknown, i: number) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(`cases[${i}] must be an object`);
    const c = v as Record<string, unknown>;
    for (const key of ['id', 'question', 'rubric', 'source']) {
      if (typeof c[key] !== 'string' || !(c[key] as string).trim()) fail(`cases[${i}].${key} must be a non-empty string`);
    }
    if (ids.has(c.id as string)) fail(`duplicate id ${c.id}`);
    ids.add(c.id as string);
    if (!(categories as readonly unknown[]).includes(c.category)) fail(`${c.id}: invalid category`);
    if (!['decided', 'default', 'open'].includes(c.status as string)) fail(`${c.id}: invalid status`);
    try { evalHistory(c.history); } catch (error) { fail(`${c.id}: ${String(error)}`); }
    for (const key of ['mustSay', 'mustNotSay', 'goldChunks']) {
      if (!Array.isArray(c[key]) || !(c[key] as unknown[]).every(x => typeof x === 'string')) fail(`${c.id}: ${key} must be a string array`);
    }
    if (c.goldChunkSets !== undefined) {
      if (!Array.isArray(c.goldChunkSets) || c.goldChunkSets.length === 0) fail(`${c.id}: goldChunkSets must be a non-empty array of evidence sets`);
      if ((c.goldChunks as string[]).length) fail(`${c.id}: goldChunks must be empty when goldChunkSets is supplied`);
      (c.goldChunkSets as unknown[]).forEach((set, index) => {
        if (!Array.isArray(set) || set.length === 0 || !set.every(id => typeof id === 'string' && id.trim() === id && id.length > 0)) fail(`${c.id}: goldChunkSets[${index}] must contain non-empty, trimmed chunk IDs`);
        if (new Set(set as string[]).size !== (set as string[]).length) fail(`${c.id}: goldChunkSets[${index}] contains duplicate IDs`);
      });
    }
    for (const pattern of [...c.mustSay as string[], ...c.mustNotSay as string[]]) {
      try { new RegExp(pattern, 'i'); } catch { fail(`${c.id}: invalid regex ${pattern}`); }
    }
  });
  return value as { version: 1; cases: EvalCase[] };
}
export async function readCases(file: string) {
  const text = await readFile(file, 'utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid eval cases: malformed JSON'); }
  return validateCases(value);
}
