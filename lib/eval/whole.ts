import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../prompt';
import { lastUsage, streamAnswer, type AskConfig } from '../claude';
import type { Answer, Approach, Usage } from './types';
import { retry } from './retry';

export function wholeApproach(config: AskConfig, client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0 })): Approach {
  let system: ReturnType<typeof buildSystemPrompt>;
  return {
    name: 'whole',
    async prepare(corpus) { system = buildSystemPrompt(corpus); },
    async answer(question): Promise<Answer> {
      const start = performance.now();
      return retry(async () => {
        let failure: unknown;
        let streamUsage: Usage | undefined;
        // streamAnswer intentionally converts API errors into visitor events. Capture the
        // original error locally to retain retry classification without changing app code.
        const wrapped = { beta: { messages: { stream: (...args: Parameters<typeof client.beta.messages.stream>) => {
          let stream: ReturnType<typeof client.beta.messages.stream>;
          try { stream = client.beta.messages.stream(...args); }
          catch (error) { failure = error; throw error; }
          return new Proxy(stream, { get(target, key) {
            if (key === Symbol.asyncIterator) return async function* () {
              try { yield* target; } catch (error) { failure = error; throw error; }
            };
            if (key === 'finalMessage') return async () => {
              try {
                const message = await target.finalMessage();
                streamUsage = message.usage;
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
        const last = lastUsage(); // Same accessor as scripts/ask.ts.
        // Another stream can finish between the generator's terminal yield and this
        // read. Its finalMessage usage belongs to that stream, so retain our copy.
        const usage = streamUsage ?? last;
        if (failure) throw failure;
        if (!complete || !usage) throw new Error('Answer stream failed or was incomplete');
        return { text, usage, timings: { firstTokenMs, totalMs: performance.now() - start } };
      });
    },
  };
}
