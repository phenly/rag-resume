#!/usr/bin/env bash
# Push production env vars to the linked Vercel project. Reads ANTHROPIC_API_KEY, RAG_MODEL and
# RAG_EFFORT from .env.local; creates an invite token per name in .env.deploy (gitignored).
# Usage: scripts/vercel-env.sh <hostname> [invitee ...]   e.g. scripts/vercel-env.sh rag-resume-x.vercel.app lee
set -euo pipefail
cd "$(dirname "$0")/.."

host="${1:?usage: vercel-env.sh <hostname> [invitee ...]}"
shift
set -a; source .env.local; set +a

touch .env.deploy && chmod 600 .env.deploy
for who in "$@"; do
  key="INVITE_$(printf '%s' "$who" | tr '[:lower:]' '[:upper:]')"
  command grep -q "^$key=" .env.deploy || printf '%s=%s\n' "$key" "$(openssl rand -hex 12)" >> .env.deploy
done
tokens="$(command grep '^INVITE_' .env.deploy | cut -d= -f2 | paste -sd, -)"

put() {
  vercel env rm "$1" production --yes >/dev/null 2>&1 || true
  printf '%s' "$2" | vercel env add "$1" production >/dev/null
  echo "set $1"
}
put ANTHROPIC_API_KEY "${DEPLOY_ANTHROPIC_API_KEY:-$ANTHROPIC_API_KEY}"
put CORPUS_DIR deploy-corpus
put RAG_MODEL "${RAG_MODEL:-claude-opus-5-5}"
put RAG_EFFORT "${RAG_EFFORT:-medium}"
put ALLOWED_HOSTS "$host"
put INVITE_TOKENS "$tokens"
