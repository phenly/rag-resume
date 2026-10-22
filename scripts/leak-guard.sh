#!/usr/bin/env bash
# Pre-commit leak guard. Checks staged changes only. Limited insurance, not a guarantee.
# Reports file name + rule ID; never prints matched text or patterns.
set -u

# Treat every filename as a literal path, never a pathspec (":(", globs, brackets).
export GIT_LITERAL_PATHSPECS=1

root="$(git rev-parse --show-toplevel)"
local_file="$root/.leak-guard.local"
fail=0

report() { printf 'leak-guard: %s  [%s]\n' "$1" "$2" >&2; fail=1; }

tmp_raw="$(mktemp)" || exit 1
tmp_names="$(mktemp)" || exit 1
trap 'rm -f "$tmp_raw" "$tmp_names"' EXIT
if ! git diff --cached --raw -z --no-renames --diff-filter=ACMR > "$tmp_raw" ||
   ! git diff --cached --name-only -z --diff-filter=ACMR > "$tmp_names"; then
  report "(staged changes)" "builtin:guard-error"
  echo "leak-guard: commit blocked. Remove the flagged content and retry." >&2
  exit 1
fi

# Built-in: staged symlinks (new mode 120000)
while IFS= read -r -d '' meta && IFS= read -r -d '' f; do
  set -- $meta
  [ "$2" = "120000" ] && report "$f" "builtin:symlink"
done < "$tmp_raw"

while IFS= read -r -d '' f; do
  base="${f##*/}"
  # Built-in: env files and the local marker file
  case "$base" in
    .env.example) ;;
    .env|.env.*|.leak-guard.local) report "$f" "builtin:env-file" ;;
  esac
  # Added lines only (skip symlinks: reported above, content is just a path)
  # Fail closed: a git failure blocks the commit instead of letting the file pass.
  if ! diff_out="$(git diff --cached -U0 --no-color -- "$f")"; then
    report "$f" "builtin:guard-error"
    continue
  fi
  added="$(printf '%s\n' "$diff_out" | grep '^+' | grep -v '^+++' || true)"
  [ -z "$added" ] && continue
  if printf '%s\n' "$added" | grep -Eq 'sk-ant-[A-Za-z0-9_-]{20,}'; then
    report "$f" "builtin:api-key"
  fi
  if [ -f "$local_file" ]; then
    n=0
    while IFS= read -r marker || [ -n "$marker" ]; do
      n=$((n + 1))
      [ -z "$marker" ] && continue
      if printf '%s\n' "$added" | grep -iqF -e "$marker"; then
        report "$f" "local:$n"
      fi
    done < "$local_file"
  fi
done < "$tmp_names"

if [ "$fail" -ne 0 ]; then
  echo "leak-guard: commit blocked. Remove the flagged content and retry." >&2
  exit 1
fi
exit 0
