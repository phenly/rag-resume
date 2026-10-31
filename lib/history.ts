import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** One finished exchange. `sig` binds the server's answer to the question and corpus version. */
export type Turn = { question: string; answer: string; sig: string };

export const MAX_HISTORY_TURNS = 6;
/** Cap on the sum of question + answer lengths across all turns sent back. */
export const MAX_HISTORY_CHARS = 16000;

export function signTurn(question: string, answer: string, secret: string, version: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([version, question, answer])).digest("hex");
}

export type ParsedHistory =
  | { ok: true; turns: Turn[] }
  | { ok: false; reason: "shape" | "limit" | "signature" };

function validSig(question: string, answer: string, sig: string, secret: string, version: string): boolean {
  const expected = Buffer.from(signTurn(question, answer, secret, version), "hex");
  const given = Buffer.from(sig, "hex");
  // Length check first: timingSafeEqual throws on unequal lengths. Non-hex input decodes short/empty.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function parseHistory(raw: unknown, secret: string, version: string): ParsedHistory {
  if (raw === undefined) return { ok: true, turns: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "shape" };
  if (raw.length > MAX_HISTORY_TURNS) return { ok: false, reason: "limit" };
  const turns: Turn[] = [];
  let chars = 0;
  for (const t of raw) {
    if (typeof t !== "object" || t === null) return { ok: false, reason: "shape" };
    const { question, answer, sig } = t as Record<string, unknown>;
    if (typeof question !== "string" || typeof answer !== "string" || typeof sig !== "string") {
      return { ok: false, reason: "shape" };
    }
    chars += question.length + answer.length;
    turns.push({ question, answer, sig });
  }
  if (chars > MAX_HISTORY_CHARS) return { ok: false, reason: "limit" };
  for (const t of turns) {
    if (!validSig(t.question, t.answer, t.sig, secret, version)) return { ok: false, reason: "signature" };
  }
  return { ok: true, turns };
}

let processSecret: string | undefined;
/**
 * HISTORY_SECRET when set. Unset on a Vercel deployment (VERCEL_ENV present) returns null: per-process
 * secrets would differ across instances, so history is disabled instead. Unset locally: a random
 * per-process secret (a restart expires conversations).
 */
export function historySecret(env: Record<string, string | undefined> = process.env): string | null {
  const set = env.HISTORY_SECRET?.trim();
  if (set) return set;
  if (env.VERCEL_ENV) return null;
  return (processSecret ??= randomBytes(32).toString("hex"));
}
