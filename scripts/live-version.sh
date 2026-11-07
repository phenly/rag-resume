#!/usr/bin/env bash
# Read the first invite without evaluating .env.deploy or logging the credential.
set +x
set -euo pipefail
cd "$(dirname "$0")/.."

json=false
if [[ $# -eq 1 && "$1" == --json ]]; then
  json=true
elif [[ $# -ne 0 ]]; then
  echo 'Usage: live-version.sh [--json]' >&2
  exit 1
fi
if [[ ! -r .env.deploy ]]; then
  echo 'Cannot read .env.deploy' >&2
  exit 1
fi
token="$(awk '/^INVITE_[A-Z_]*=/ { sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit }' .env.deploy)"
# Accept the usual quoted dotenv values too; never source the file as shell code.
if [[ "$token" == \"*\" || "$token" == \'*\' ]]; then
  token="${token:1:${#token}-2}"
fi
if [[ -z "$token" ]]; then
  echo 'No invite token in .env.deploy' >&2
  exit 1
fi

if ! response="$(printf 'Cookie: invite=%s\n' "$token" |
  curl --disable --silent --connect-timeout 5 --max-time 15 --write-out $'\n%{http_code}' \
    --header @- "${SITE_URL:-https://rag-resume.pixelbytes.net}/api/version")"; then
  echo 'Live version is unreachable' >&2
  exit 1
fi
unset token
http_status="${response##*$'\n'}"
response="${response%$'\n'*}"
if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
  printf 'Live version request failed: HTTP %s\n' "$http_status" >&2
  exit 1
fi
printf '%s' "$response" | node -e '
try {
  const body = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (!body || typeof body.version !== "string" || !/^[a-zA-Z0-9._-]+$/.test(body.version))
    throw new Error();
  if (process.argv[1] === "--json") {
    const r = body.retrieval;
    if (body.approach !== "whole" || !/^[a-f0-9]{64}$/.test(body.retrievalConfigVersion) || !r || r.status !== "ready" || r.corpusVersion !== body.version ||
      !/^[a-f0-9]{64}$/.test(r.indexVersion) || r.schemaVersion !== 1 ||
      typeof r.embeddingModel !== "string" || !Number.isSafeInteger(r.dimensions) || r.dimensions <= 0) throw new Error();
    console.log(JSON.stringify({ version: body.version, approach: body.approach, retrievalConfigVersion: body.retrievalConfigVersion, retrieval: {
      status: r.status, corpusVersion: r.corpusVersion, indexVersion: r.indexVersion,
      schemaVersion: r.schemaVersion, embeddingModel: r.embeddingModel, dimensions: r.dimensions
    } }));
  } else console.log(body.version);
} catch {
  console.error("Invalid live version response");
  process.exitCode = 1;
}
' -- "$(if [[ "$json" == true ]]; then printf %s --json; fi)"
