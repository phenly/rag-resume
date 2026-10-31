#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 0 ]]; then
  echo 'Usage: corpus-status.sh' >&2
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
