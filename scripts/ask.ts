import { loadCorpus, resolveCorpusDir } from "../lib/corpus";
import { buildSystemPrompt } from "../lib/prompt";
import { lastStats, lastUsage, readAskConfig, streamAnswer } from "../lib/claude";
import type { AskEvent } from "../lib/events";

async function main(): Promise<number> {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: npm run ask -- "your question"');
    return 2;
  }
  const config = readAskConfig();
  const system = buildSystemPrompt(await loadCorpus(resolveCorpusDir()));
  let terminal: AskEvent | null = null;
  for await (const e of streamAnswer(question, system, config)) {
    if (e.type === "text") process.stdout.write(e.text);
    else terminal = e;
  }
  console.log("\n\nterminal event:", JSON.stringify(terminal));
  const u = lastUsage();
  console.log(
    "usage:",
    JSON.stringify({
      input_tokens: u?.input_tokens,
      cache_creation_input_tokens: u?.cache_creation_input_tokens,
      cache_read_input_tokens: u?.cache_read_input_tokens,
      output_tokens: u?.output_tokens,
    }),
  );
  const st = lastStats();
  console.log("visible words:", st.words, "| event types:", st.eventTypes.join(","), "| delta types:", st.deltaTypes.join(","));
  return terminal?.type === "done" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
