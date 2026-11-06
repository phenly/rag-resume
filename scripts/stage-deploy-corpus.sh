#!/usr/bin/env bash
# Stage and validate a matching immutable corpus/index pair before replacing output.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node node_modules/tsx/dist/cli.mjs scripts/stage-deploy-corpus.ts "$@"
