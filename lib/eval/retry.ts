import Anthropic from '@anthropic-ai/sdk';
import type { Usage } from './types';

/** Account spend quota is an operator action, never transient rate limiting. */
export function isAccountQuotaError(error: unknown): boolean {
  const value = error as { status?: unknown; message?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message : String(error);
  const status400 = value?.status === 400 || (value?.status === undefined && /^(?:Error:\s*)?400\b/.test(message));
  return status400 && /reached your specified API usage limits/i.test(message);
}

export async function retry<T>(call: () => Promise<T>, pause: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); } catch (error) {
      const e = error as { status?: number; message?: string };
      if (isAccountQuotaError(error) || attempt >= 2 || !(error instanceof Anthropic.APIConnectionError || e.status === 408 || e.status === 409 || e.status === 429 || (e.status !== undefined && e.status >= 500) || /overloaded/i.test(e.message ?? ''))) throw error;
      await pause(250 * 2 ** attempt);
    }
  }
}

/** Keep returned usage across retries; missing/partial usage makes the total a lower bound. */
export async function retryWithUsage<T extends { usage: Usage; usageIncomplete?: boolean }>(call: () => Promise<T>): Promise<T & { usageIncomplete?: boolean }> {
  let usage: Usage | undefined;
  let incomplete = false;
  const add = (next?: Usage) => {
    if (!next) return;
    if (!usage) { usage = { ...next }; return; }
    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
      if (usage[key] != null || next[key] != null) usage[key] = (usage[key] ?? 0) + (next[key] ?? 0);
    }
  };
  try {
    const result = await retry(async () => {
      try { return await call(); }
      catch (error) {
        const e = error as { usage?: Usage; usageIncomplete?: boolean };
        add(e.usage);
        incomplete ||= !e.usage || !!e.usageIncomplete;
        throw error;
      }
    });
    add(result.usage);
    return { ...result, usage: usage!, ...(incomplete || result.usageIncomplete ? { usageIncomplete: true } : {}) };
  } catch (error) {
    throw Object.assign(error instanceof Object ? error : new Error(String(error)), { usage, usageIncomplete: incomplete });
  }
}
