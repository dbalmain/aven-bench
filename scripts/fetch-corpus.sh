#!/usr/bin/env bash
# Fetch (or update) the Exercism problem-specifications corpus into vendor/.
#
# vendor/ is gitignored: it is an upstream checkout, not our source. The
# committed artefact is corpus/, produced from this checkout by
# `bun run ingest`.
#
# Upstream: https://github.com/exercism/problem-specifications  (MIT licensed)
set -euo pipefail

REPO_URL="${AVEN_BENCH_SPEC_REPO:-https://github.com/exercism/problem-specifications.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/problem-specifications"

mkdir -p "$ROOT/vendor"

if [ -d "$DEST/.git" ]; then
  echo "updating $DEST"
  git -C "$DEST" fetch --depth 1 origin HEAD
  git -C "$DEST" reset --hard FETCH_HEAD
else
  echo "cloning $REPO_URL -> $DEST"
  git clone --depth 1 "$REPO_URL" "$DEST"
fi

echo
echo "problem-specifications at $(git -C "$DEST" rev-parse HEAD)"
echo "exercises: $(find "$DEST/exercises" -maxdepth 1 -mindepth 1 -type d | wc -l)"
echo "with canonical-data.json: $(find "$DEST/exercises" -name canonical-data.json | wc -l)"
echo
echo "next: bun run ingest"
