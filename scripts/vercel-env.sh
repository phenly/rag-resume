#!/usr/bin/env bash
# Push production env vars to the linked Vercel project. Reads ANTHROPIC_API_KEY, RAG_MODEL and
# RAG_EFFORT from .env.local; creates HISTORY_SECRET and an invite token per name in .env.deploy (gitignored).
# The answering approach comes from .env.deploy: CVAI_APPROACH=whole|rag (default whole) and, for rag,
# CVAI_RETRIEVAL_STRATEGY=jev|wide. rag also pushes VOYAGE_API_KEY and RAG_GENERATOR_CONTEXT_TOKENS from .env.local.
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
command grep -q '^HISTORY_SECRET=' .env.deploy || printf 'HISTORY_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.deploy
history_secret="$(command grep '^HISTORY_SECRET=' .env.deploy | cut -d= -f2)"
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
put HISTORY_SECRET "$history_secret"

deploy_value() { command grep "^$1=" .env.deploy | head -n 1 | cut -d= -f2- || true; }
approach="$(deploy_value CVAI_APPROACH)"; approach="${approach:-whole}"
[[ "$approach" == whole || "$approach" == rag ]] || { echo 'CVAI_APPROACH in .env.deploy must be whole or rag' >&2; exit 1; }
put CVAI_APPROACH "$approach"
if [[ "$approach" == rag ]]; then
  strategy="$(deploy_value CVAI_RETRIEVAL_STRATEGY)"; strategy="${strategy:-jev}"
  [[ "$strategy" == jev || "$strategy" == wide ]] || { echo 'CVAI_RETRIEVAL_STRATEGY in .env.deploy must be jev or wide' >&2; exit 1; }
  : "${VOYAGE_API_KEY:?rag needs VOYAGE_API_KEY in .env.local}"
  : "${RAG_GENERATOR_CONTEXT_TOKENS:?rag needs RAG_GENERATOR_CONTEXT_TOKENS in .env.local}"
  put CVAI_RETRIEVAL_STRATEGY "$strategy"
  put VOYAGE_API_KEY "$VOYAGE_API_KEY"
  put RAG_GENERATOR_CONTEXT_TOKENS "$RAG_GENERATOR_CONTEXT_TOKENS"
  if [[ "$strategy" == jev ]]; then
    : "${TYPESAFE_API_KEY:?the jev strategy needs TYPESAFE_API_KEY in .env.local}"
    put TYPESAFE_API_KEY "$TYPESAFE_API_KEY"
  fi
fi
