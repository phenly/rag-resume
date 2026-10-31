#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

no_deploy=false
if [[ $# -eq 1 && "$1" == --no-deploy ]]; then
  no_deploy=true
elif [[ $# -ne 0 ]]; then
  echo 'Usage: publish.sh [--no-deploy]' >&2
  exit 1
fi

VAULT="${VAULT:-$(awk '/^VAULT=/ { print substr($0, index($0, "=") + 1); exit }' .env.local 2>/dev/null)}"
: "${VAULT:?Set VAULT=<path to your vault> in .env.local}"
SOURCE="$VAULT/Career/Source"
GENTE="$VAULT/Reference/Gente"
CORPUS="$VAULT/Coding/rag-resume/corpus"

# Use the installed tsx only, even if npm would otherwise try to download it.
export npm_config_offline=true npm_config_yes=false
career-source lint --source "$SOURCE"
career-source export-bot --source "$SOURCE" --gente "$GENTE" --out "$CORPUS/career"
report_args=("$CORPUS")
if [[ -f "$CORPUS/published.json" ]]; then
  report_args+=(--against "$CORPUS/published.json")
fi
report="$(npx tsx scripts/corpus-report.ts "${report_args[@]}")"
printf '%s\n' "$report"
local_version="${report%%$'\n'*}"
local_version="${local_version#version }"
scripts/stage-deploy-corpus.sh "$CORPUS"

if [[ "$no_deploy" == true ]]; then
  echo 'Staged. Not deployed (--no-deploy).'
  exit 0
fi

vercel deploy --prod --yes
live_version=unreachable
for ((attempt = 1; attempt <= 12; attempt++)); do
  if live_version="$(scripts/live-version.sh 2>/dev/null)"; then
    if [[ "$live_version" == "$local_version" ]]; then
      npx tsx scripts/corpus-report.ts "$CORPUS" --write "$CORPUS/published.json"
      printf 'Live and current: %s\n' "$local_version"
      exit 0
    fi
  else
    live_version=unreachable
  fi
  if ((attempt < 12)); then sleep 5; fi
done
printf 'Live version %s does not match %s\n' "$live_version" "$local_version" >&2
exit 1
