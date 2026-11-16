#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

commit=false
if [[ $# -eq 1 && "$1" == --commit ]]; then
  commit=true
elif [[ $# -ne 0 ]]; then
  echo 'Usage: corpus-status.sh [--commit]' >&2
  exit 1
fi
VAULT="${VAULT:-$(awk '/^VAULT=/ { print substr($0, index($0, "=") + 1); exit }' .env.local 2>/dev/null)}"
: "${VAULT:?Set VAULT=<path to your vault> in .env.local}"
SOURCE="$VAULT/Career/Source"
GENTE="$VAULT/Reference/Gente"
CORPUS="$VAULT/Coding/rag-resume/corpus"
export npm_config_offline=true npm_config_yes=false

tmp="$(mktemp -d "${TMPDIR:-/tmp}/corpus-status.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
# Dereference links so exporting into the copy cannot overwrite linked originals.
cp -RL "$CORPUS/." "$tmp/"
# Manifest documents may point outside the corpus folder (the LinkedIn capture does);
# pin them to absolute paths so the copy still finds them.
if [[ -f "$tmp/corpus.json" ]]; then
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const [corpus, file] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    m.documents = (m.documents ?? []).map((d) => ({ ...d, path: path.resolve(corpus, d.path) }));
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
  ' "$CORPUS" "$tmp/corpus.json"
fi
# A clean export must establish which files are generated; a copied stray file
# must never qualify for a commit simply because the exporter leaves it alone.
if [[ -d "$tmp/career" ]]; then mv "$tmp/career" "$tmp/.previous-career"; fi
career-source export-bot --source "$SOURCE" --gente "$GENTE" --out "$tmp/career" >&2

published=none
baseline="$tmp/published.json"
if [[ -f "$baseline" ]]; then
  published="$(node -e '
    try {
      const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (!value || typeof value.version !== "string" || !value.version.trim()) throw new Error();
      console.log(value.version);
    } catch {
      console.error("Invalid published snapshot");
      process.exitCode = 1;
    }
  ' "$baseline")"
else
  # A first publication compares against an empty corpus, so every entry is added.
  baseline="$tmp/.unpublished.json"
  printf '%s\n' '{"version":"none","files":{"profile":"","answerStyle":"","positioningNotes":"","globalRules":""},"chunks":{}}' > "$baseline"
fi
report="$(npx tsx scripts/corpus-report.ts "$tmp" --against "$baseline")"
source_version="${report%%$'\n'*}"
source_version="${source_version#version }"
if ! live_version="$(scripts/live-version.sh 2>/dev/null)"; then
  live_version=unreachable
fi
printf 'live %s\npublished %s\nsource now %s\n' "$live_version" "$published" "$source_version"
if [[ "$live_version" == "$published" && "$published" == "$source_version" ]]; then
  echo current
else
  printf '%s\n' "${report#*$'\n'}"
fi

if [[ "$commit" == true ]]; then
  local_report="$(npx tsx scripts/corpus-report.ts "$CORPUS")"
  local_version="${local_report%%$'\n'*}"
  local_version="${local_version#version }"
  if [[ "$live_version" != "$published" || "$source_version" != "$published" || "$local_version" != "$published" ]]; then
    echo 'Corpus not committed: local, source, published and live versions must match.' >&2
    exit 1
  fi

  # Use the private vault repository, never the application's public repository.
  vault_root="$(git -C "$VAULT" rev-parse --show-toplevel)"
  [[ "$vault_root" == "$(cd "$VAULT" && pwd -P)" ]] || { echo 'VAULT must be the vault repository root' >&2; exit 1; }
  git -C "$VAULT" diff HEAD --name-only -z -- Coding/rag-resume/corpus/career/ Coding/rag-resume/corpus/published.json > "$tmp/commit-paths"
  git -C "$VAULT" ls-files --others --exclude-standard -z -- Coding/rag-resume/corpus/career/ Coding/rag-resume/corpus/published.json >> "$tmp/commit-paths"
  paths=()
  while IFS= read -r -d '' file; do
    relative="${file#Coding/rag-resume/corpus/}"
    # Check bytes as well as semantic versions: do not sweep unrelated files or
    # manually edited exporter metadata into the commit. Missing files fail safe.
    if [[ -L "$CORPUS/$relative" || ! -f "$tmp/$relative" ]] || ! cmp -s "$CORPUS/$relative" "$tmp/$relative"; then
      printf 'Corpus not committed: %s differs from the verified export.\n' "$relative" >&2
      exit 1
    fi
    paths+=("$file")
  done < "$tmp/commit-paths"
  if ((${#paths[@]})); then
    git -C "$VAULT" add -- "${paths[@]}"
    message="Record published corpus $published"
    if [[ -n "${CODEX_THREAD_ID:-}" ]]; then
      message+=$'\n\nSession: '"$CODEX_THREAD_ID"
    fi
    git -C "$VAULT" commit -m "$message" -- "${paths[@]}"
  else
    echo 'Published corpus already committed.'
  fi
fi
