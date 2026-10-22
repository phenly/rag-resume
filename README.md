# rag-resume

A local-only Next.js page that answers questions about a candidate by sending their career archive to Claude. Work in progress.

## Setup

```
npm install
cp .env.example .env.local   # then add your ANTHROPIC_API_KEY
git config core.hooksPath .githooks
npm run dev                  # binds to 127.0.0.1 only
npm test
```

## Leak guard

`scripts/leak-guard.sh` runs as a pre-commit hook. It blocks staged `.env*` files, Anthropic-style API keys, symlinks, and any line matching a case-insensitive fixed string listed in your own untracked `.leak-guard.local` (one per line). It reports the file and rule ID only, never the matched text.

This is limited insurance, not a guarantee: it only sees staged added lines, and only the patterns and markers it knows about. Review your diff before pushing.
