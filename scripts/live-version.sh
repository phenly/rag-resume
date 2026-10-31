#!/usr/bin/env bash
# Read the first invite without evaluating .env.deploy or logging the credential.
set +x
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 0 ]]; then
  echo 'Usage: live-version.sh' >&2
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

if ! response="$(curl --disable --fail --silent --connect-timeout 5 --max-time 15 \
  --header "Cookie: invite=$token" "${SITE_URL:-https://rag-resume.pixelbytes.net}/api/version")"; then
  echo 'Live version is unreachable' >&2
  exit 1
fi
unset token
printf '%s' "$response" | node -e '
try {
  const body = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (!body || typeof body.version !== "string" || !/^[a-zA-Z0-9._-]+$/.test(body.version))
    throw new Error();
  console.log(body.version);
} catch {
  console.error("Invalid live version response");
  process.exitCode = 1;
}
'
