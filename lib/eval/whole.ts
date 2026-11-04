import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../prompt';
import { streamAnswer, type AskConfig } from '../claude';
import type { Answer, Approach, Usage } from './types';
import { retryWithUsage } from './retry';

export function wholeApproach(config: AskConfig, client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 })): Approach {
  let system: ReturnType<typeof buildSystemPrompt>;
  return {
    name: 'whole',
    async prepare(corpus) { system = buildSystemPrompt(corpus); },
    async answer(question): Promise<Answer> {
      const start = performance.now();
      return retryWithUsage(async () => {
        let failure: unknown;
        let streamUsage: Usage | undefined;
        let finalUsage = false;
        // streamAnswer intentionally converts API errors into visitor events. Capture the
        // original error locally to retain retry classification without changing app code.
        const wrapped = { beta: { messages: { stream: (...args: Parameters<typeof client.beta.messages.stream>) => {
          let stream: ReturnType<typeof client.beta.messages.stream>;
          try { stream = client.beta.messages.stream(...args); }
          catch (error) { failure = error; throw error; }
          return new Proxy(stream, { get(target, key) {
            if (key === Symbol.asyncIterator) return async function* () {
              try {
                for await (const event of target) {
                  if (event.type === 'message_start') streamUsage = { ...event.message.usage };
                  else if (event.type === 'message_delta' && streamUsage) {
                    // Stream usage snapshots are cumulative within an attempt.
                    for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
                      if (event.usage[key] != null) streamUsage[key] = event.usage[key]!;
                    }
                  }
                  yield event;
                }
              } catch (error) { failure = error; throw error; }
            };
            if (key === 'finalMessage') return async () => {
              try {
                const message = await target.finalMessage();
                streamUsage = message.usage;
                finalUsage = true;
                return message;
              } catch (error) { failure = error; throw error; }
            };
            const v = Reflect.get(target, key);
            return typeof v === 'function' ? v.bind(target) : v;
          } });
        } } } } as unknown as Anthropic;
        let text = '';
        let firstTokenMs: number | null = null;
        let complete = false;
        for await (const event of streamAnswer(question, system, config, wrapped)) {
          if (event.type === 'text') {
            if (firstTokenMs === null && event.text) firstTokenMs = performance.now() - start;
            text += event.text;
          } else if (event.type === 'done') complete = event.status !== 'incomplete';
        }
        const timings = { firstTokenMs, totalMs: performance.now() - start };
        if (failure || !complete || !streamUsage) {
          const error = failure instanceof Object ? failure : new Error(failure ? String(failure) : 'Answer stream failed or was incomplete');
          throw Object.assign(error, { usage: streamUsage ?? (error as { usage?: Usage }).usage, timings, usageIncomplete: !finalUsage });
        }
        return { text, usage: streamUsage, timings };
      });
    },
  };
}
