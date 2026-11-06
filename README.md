# rag-resume

> [!WARNING]
> **Work in progress (alpha).** This is a personal project under active development, not a finished product. Expect rough edges, breaking changes to the corpus format, scripts, and settings, and documentation that may lag the code. There is no stability or support promise yet, and the RAG approach the name refers to is still being built (see [Evaluation harness](#evaluation-harness)).

A local-only Next.js page that answers questions about a candidate by sending their career archive to Claude. A visitor sees a profile card and a messaging-style chat: their question appears on the right, Claude's answer streams in on the left, and answers cite the notes they came from in a "Based on" line.

There is also a plain-language `/how-it-works` page explaining the flow for a non-technical reader.

## Run it on the sample corpus

The repo ships with a fictional candidate, "Jordan Example", in `sample-corpus/`.

```
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
git config core.hooksPath .githooks
npm run dev                  # binds to 127.0.0.1 only
```

Open http://127.0.0.1:3000. Under the profile you will see example questions (three shown, plus "More examples"; "Try to break it" is collapsed). Clicking one fills the question box so you can edit it before sending.

Settings in `.env.local`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | (none, required) | Your Anthropic API key |
| `CORPUS_DIR` | `sample-corpus` | Folder holding the career archive |
| `RAG_MODEL` | `claude-opus-5-5` | Model used to answer |
| `RAG_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh`, or `max` |
| `RAG_MAX_TOKENS` | `2500` | Combined reasoning/output token allowance; accepts safe integers of at least `256`. Unset, nonnumeric, fractional, unsafe, or smaller values use `2500`. |
| `HISTORY_SECRET` | (random per process) | Key that signs answers so the server can trust the conversation history the browser sends back. Set it in production (`scripts/vercel-env.sh` does); unset, a restart expires open conversations. |

## Use your own corpus

Point `CORPUS_DIR` at a folder of your own (absolute path, or relative to the repo). Keep it outside the repo if it contains real data. The folder holds:

- `corpus.json`, the manifest.
- `profile.json`, what the profile card shows.
- `positioning-notes.md`, guidance on how to present the candidate and what to withhold.
- `answer-style.md` (optional), guidance on answer length and shape.
- The documents themselves (Markdown or text).

`corpus.json` lists those files. Paths are absolute or relative to the corpus folder:

```json
{
  "profile": "profile.json",
  "positioningNotes": "positioning-notes.md",
  "answerStyle": "answer-style.md",
  "documents": [
    { "title": "Career inventory", "path": "inventory.md" },
    { "title": "Story bank", "path": "story-bank.md" }
  ]
}
```

The optional `answerStyle` path loads the file's text as the prompt's Answer style section. If omitted, the built-in style in `lib/answer-style.ts` gives first answers and unrelated new questions a 3 to 5 sentence, 60 to 100 word overview. Follow-ups on a previous thread explore just that thread in about 150 words, never past 250 words. Both prefer short paragraphs to long lists. The sample style file matches this default. `scripts/stage-deploy-corpus.sh` copies a supplied style file into the deployment corpus as `answer-style.md`.

`profile.json` (see `sample-corpus/profile.json` for a full example):

```json
{
  "name": "Jordan Example",
  "photo": "avatar.png",
  "headline": "Product leader for logistics software",
  "about": "A short paragraph about the candidate.",
  "links": [{ "label": "Profile", "url": "https://example.com/jordan" }],
  "blurb": "A sentence explaining what this page does.",
  "starterQuestions": ["What did Jordan accomplish at their last job?"],
  "breakItQuestions": ["What salary does Jordan want?"]
}
```

The `photo` is optional. It must be a `.jpg`, `.jpeg`, `.png`, or `.webp` file inside the corpus folder, and it is served at `/api/photo`. Without one the card shows the candidate's initials.

Email addresses, phone numbers, and similar contact details are removed from documents before they reach Claude.

**Restart the dev server after editing the corpus.** The corpus is loaded once and cached, so changes do not appear until you stop and rerun `npm run dev`.

## Publishing

The publishing scripts require the existing Node dependencies and the `career-source` CLI on `PATH`. They read the vault path from `VAULT`, or from a `VAULT=` line in `.env.local`. The source is `Career/Source`, person notes are in `Reference/Gente`, and the corpus is `Coding/rag-resume/corpus`, all beneath that vault. Keep the vault outside code repositories. Exported career files go to the vault's `Coding/rag-resume/corpus/career/` folder.

Set `"documentsFrom": "career/bot-export.json"` in the vault's `corpus.json`. Every document listed by the exporter is loaded automatically. Keep the profile, positioning notes, answer style, and photo inside the corpus folder; manifest documents outside it (such as a LinkedIn capture) are pinned to absolute paths when `corpus-status.sh` copies the corpus. `bot-export.json` must include `chunks`, either a list of `{id, title, hash}` (what `career-source` writes) or an object keyed by entry ID; missing or malformed chunk metadata fails the report.

```bash
scripts/publish.sh --no-deploy  # lint, export, show changes, and stage deploy-corpus/
scripts/corpus-status.sh       # compare live, last published, and current source
```

Agents use `--no-deploy`. The operator runs `scripts/publish.sh` without that flag to deploy. Every step stops on failure. After deployment, the script checks `/api/version` up to 12 times, five seconds apart, and writes `published.json` in the vault corpus only after the live version matches. A failed live check leaves the published snapshot unchanged. Avoid editing the corpus while publishing.

`scripts/live-version.sh` reads the first `INVITE_[A-Z_]*=` value from the repository's untracked `.env.deploy` and sends it as an invite cookie without printing it. `SITE_URL` defaults to `https://rag-resume.pixelbytes.net`; override it for another deployment. A missing invite, failed request, or invalid version response exits with an error.

`corpus-status.sh` copies the corpus into a temporary folder and exports fresh source there. It prints `live`, `published`, and `source now` versions, then `current` when all match or a change list against the published snapshot. An unreachable site is shown as `unreachable`; before the first publication, `published` is `none` and every exported chunk is listed as added. The temporary copy is removed on exit.

To inspect changes directly, run `npx tsx scripts/corpus-report.ts "$VAULT/Coding/rag-resume/corpus" --against "$VAULT/Coding/rag-resume/corpus/published.json"`. Omit `--against` before the first publication. Reports show added, changed, and removed entry IDs and titles, plus changes to positioning notes, answer style, profile, and global rules. `--write <snapshot.json>` saves the version, file hashes, and exported chunks; the publishing script manages the published snapshot after its live check.

## Cost

The whole archive is sent with every question (cached after the first). Each answer uses roughly 1,000 output tokens at the default effort, much of it hidden thinking. Set `RAG_EFFORT=low` to reduce that. Consider setting a spend limit in the Anthropic Console.

## Tests

```
npm test            # fast, offline, no API calls
npm run test:live   # real Claude API calls: COSTS MONEY
```

`npm test` excludes `tests/live/`. The live tests always use `sample-corpus` (ignoring `CORPUS_DIR`), need `ANTHROPIC_API_KEY` in `.env.local`, and are never run automatically. With `RUN_LIVE=1` and no key they fail with a clear message rather than skipping. They check that internal-only content stays withheld and that a starter question gets an answer with a "Based on" line.

## Leak guard

`scripts/leak-guard.sh` runs as a pre-commit hook. It blocks staged `.env*` files, Anthropic-style API keys, symlinks, and any line matching a case-insensitive fixed string listed in your own untracked `.leak-guard.local` (one per line). It reports the file and rule ID only, never the matched text.

This is limited insurance, not a guarantee: it only sees staged added lines (it does not scan binary files such as photos), and only the patterns and markers it knows about. Review your diff before pushing.

## Evaluation harness

Run against the fictional sample corpus or set `CORPUS_DIR` to your private corpus. Keep results outside the repo: answers, judge reasoning, and matching patterns can contain private career material.

```bash
npm run eval -- --help
CORPUS_DIR=sample-corpus npm run eval -- --cases eval/sample-cases.json --out /tmp/cv-ai-evals
npm run eval -- --cases /private/path/cases.json --out /private/path/evals --approach both --only G1,L1 --concurrency 3
```

Case files use `{ "version": 1, "cases": [...] }`; see `eval/sample-cases.json` for the shared schema. Each case has `id`, `category`, `question`, `status`, `rubric`, `mustSay`, `mustNotSay`, `goldChunks`, and `source`. Regex patterns use JavaScript's case-insensitive flag. Status is `decided`, `default`, or `open`; categories are `grounded`, `tricky`, `not-in-notes`, `redirect`, `decline`, `personal`, `leak-probe`, or `adversarial`. Exported corpus gold IDs must exist in `career/bot-export.json`'s chunk index; the sample uses its inline atom IDs.

For questions with alternative valid stories, set `goldChunks: []` and add optional `goldChunkSets`, for example `[["EX-A", "EX-B"], ["EX-C"]]`. Each non-empty inner set is one complete evidence option; IDs must be non-empty, trimmed and unique within it. Retrieval selects the option with the highest recall (first declared option on ties), rather than combining partial hits across options. Reports expose its zero-based `selectedGoldSetIndex`; ranks and recall use that option. Retrieved IDs are deduplicated before counting or ranking, while rerank drops retain the original trace. Existing flat `goldChunks` cases remain supported.

The first question finishes before concurrent work starts (default three workers afterward). The whole approach reuses the app's corpus loader, cached prompt, configuration, streaming adapter, and per-stream usage. `lib/eval/types.ts` defines `Approach`: `name`, `prepare(corpus)`, and `answer(question)`, returning text, usage, timings, optional retrieval IDs and rerank drops. Add a future RAG implementation through this boundary; today `--approach rag` reports **not built**, and `both` runs whole plus that placeholder.

An API key is required for whole runs, including `--no-judge` (answers and exact token counting still call Anthropic). The structured-output judge defaults to `claude-sonnet-5-5`; override `EVAL_JUDGE_MODEL`. Answer settings use the existing `RAG_MODEL`, `RAG_EFFORT`, and `RAG_MAX_TOKENS`. Prices live only in `lib/eval/pricing.ts`; unknown model prices produce `null` costs, never invented estimates. API calls retry at most twice for SDK connection/timeout errors, HTTP 408/409/429, 5xx, or overload errors; individual answer/judge errors are recorded. Returned usage (including partial streaming usage) accumulates across attempts, and answer failures retain available usage and timings. Missing or partial billed usage makes summary totals `null` with `costIncomplete: true`; `knownDollars` reports the available spend as a lower bound. Disabled or unattempted judging costs zero.

Each run writes `YYYY-MM-DDTHHmm-<version8>/results.json` and `report.md`, plus a summary line in `runs.jsonl`; same-minute collisions get a numeric suffix. Times use UTC. Reports exclude `open` cases and **all leak probes** from pass rates, list leaks separately, and record unsupported claims as grounding findings. A pass requires all regex checks, `rubricMet`, no unsupported claims, and no judge-detected leak. Judge-detected leaks fail every category. The judge receives source facts, positioning notes and handling rules, global source rules, and answer-style guidance in separately labeled sections. Career claims must be supported by source facts; positioning and style guide framing and can restrict disclosure, but do not establish career facts. Clearly signaled humor authorized by the rubric/style is not graded as a literal career claim, and optional examples or suggested ordering are not mandatory. Cost per passing answer includes answer and judge spend over the same eligible cases as the pass-rate denominator; `totalDollars` reports all-case operational spend separately. Judge errors count as non-passes. `--no-judge` produces checks and `unjudged` results with no pass rate. No API calls occur with `--help`, and rag-only runs need no API key.

Token totals come directly from the installed SDK token-count API for the exact `buildSystemPrompt` blocks, with no visitor question. Counts by part use independent API requests and may include framing overhead, so they need not sum to the combined total. Full profile JSON is counted separately as supplemental material: the live prompt currently uses only the profile name in generated answer rules. Token-count failures are recorded explicitly rather than replaced by estimates. RAG embedding cost, index freshness, retrieval recall/rank/unused chunks, rerank drops, and stage timings have reserved fields. Offline unit tests mock the Anthropic client; they never call live APIs.
