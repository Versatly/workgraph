#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

WORKSPACE=""
SKIP_BUILD=0
JSON_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace|-w)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        exit 1
      fi
      WORKSPACE="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --json)
      JSON_MODE=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: run.sh [--workspace <path>] [--skip-build] [--json]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${WORKSPACE}" ]]; then
  WORKSPACE="$(mktemp -d /tmp/workgraph-obj09-showcase-XXXXXX)"
fi

if [[ "${SKIP_BUILD}" -ne 1 ]]; then
  echo "[obj-09] building repository artifacts..." >&2
  (
    cd "${REPO_ROOT}"
    pnpm run build >/dev/null
  )
fi

SHOWCASE_ARGS=(--workspace "${WORKSPACE}" --json)
if [[ "${SKIP_BUILD}" -eq 1 ]]; then
  SHOWCASE_ARGS+=(--skip-build)
fi

if [[ "${JSON_MODE}" -ne 1 ]]; then
  echo "[obj-09] running showcase in ${WORKSPACE}" >&2
fi

node "${SCRIPT_DIR}/scripts/run-showcase.mjs" "${SHOWCASE_ARGS[@]}"
