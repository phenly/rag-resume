import type { Usage } from './types';
// USD per million tokens (claude-api skill pricing table, cached 2026-10-06; checked 2026-11-03). All cache writes use 1h TTL.
export const MODEL_PRICES: Record<string, { input: number; write: number; read: number; output: number }> = {
  'claude-opus-5-5': { input: 4, write: 8, read: 0.20, output: 20 },
  'claude-sonnet-5-5': { input: 2, write: 4, read: 0.20, output: 10 },
};
export function dollars(model: string, u: Usage): number | null {
  const p = MODEL_PRICES[model];
  return p ? (u.input_tokens * p.input + (u.cache_creation_input_tokens ?? 0) * p.write + (u.cache_read_input_tokens ?? 0) * p.read + u.output_tokens * p.output) / 1e6 : null;
}
