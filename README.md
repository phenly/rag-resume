# rag-resume

A local-only Next.js page that answers questions about a candidate by sending their career archive to Claude. A visitor sees a profile card and a messaging-style chat: their question appears on the right, Claude's answer streams in on the left, and answers cite the notes they came from in a "Based on" line. Work in progress (alpha).

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
| `RAG_MAX_TOKENS` | `1500` | Maximum output tokens; accepts safe integers of at least `256`. Unset, nonnumeric, fractional, unsafe, or smaller values use `1500`. |
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
