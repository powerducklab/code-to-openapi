#!/usr/bin/env bash
#
# fetch-corpus.sh - Materialize the real-world backend API corpus locally.
#
# Reads manifest.json and shallow-clones every third-party project at its
# pinned commit into ./repos. The checkouts are git-ignored and are never
# redistributed; they exist only for local scanner evaluation.
#
# Usage:
#   ./fetch-corpus.sh            # fetch/check every checkpoint
#   ./fetch-corpus.sh express    # fetch only one framework id
#
# Requirements: git, python3 (3.6+). Honors HTTPS_PROXY / https_proxy when set.
# Written for bash 3.2 (the default on macOS), so no mapfile / associative
# arrays are used.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/manifest.json"
REPOS="$HERE/repos"
ONLY="${1:-}"

if [[ ! -f "$MANIFEST" ]]; then
  echo "manifest.json not found next to this script" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

TSV="$(mktemp -t c2o-corpus.XXXXXX)"
trap 'rm -f "$TSV"' EXIT

# Emit one TSV line per checkpoint:
# framework <TAB> repo <TAB> commit <TAB> branch <TAB> dir <TAB> subdir
python3 - "$MANIFEST" "$ONLY" > "$TSV" <<'PY'
import json
import sys

manifest = json.load(open(sys.argv[1]))
only = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
for fw, entries in manifest["frameworks"].items():
    if only and fw != only:
        continue
    for e in entries:
        print("\t".join([
            fw,
            e["repo"],
            e.get("commit") or "",
            e.get("branch") or "",
            e["dir"],
            e.get("subdir") or "",
        ]))
PY

total="$(grep -c . "$TSV" || true)"
ok=0
skipped=0
failed=0

while IFS=$'\t' read -r fw repo commit branch dir subdir; do
  [[ -z "${fw:-}" ]] && continue
  dest="$HERE/$dir"
  url="https://github.com/$repo.git"

  if [[ -d "$dest/.git" ]]; then
    current="$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)"
    if [[ -z "$commit" || "$current" == "$commit" ]]; then
      skipped=$((skipped + 1))
      printf '[skip] %s/%s (already at %s)\n' "$fw" "$repo" "${current:0:10}"
      continue
    fi
  fi

  mkdir -p "$(dirname "$dest")"
  echo "[fetch] $fw/$repo @ ${commit:0:10}"
  if git clone --quiet --depth 1 --single-branch --branch "$branch" \
        -- "$url" "$dest" >/dev/null 2>&1; then
    :
  else
    # Branch clone can fail on unusual default refs; fall back to an
    # unqualified shallow clone before pinning the commit.
    rm -rf "$dest"
    if ! git clone --quiet --depth 1 --single-branch -- "$url" "$dest" >/dev/null 2>&1; then
      echo "  FAILED to clone $url" >&2
      failed=$((failed + 1))
      continue
    fi
  fi

  if [[ -n "$commit" ]]; then
    current="$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$current" != "$commit" ]]; then
      git -C "$dest" fetch --quiet --depth 1 origin "$commit" >/dev/null 2>&1 || true
      git -C "$dest" checkout --quiet --detach "$commit" >/dev/null 2>&1 || \
        git -C "$dest" checkout --quiet --detach FETCH_HEAD >/dev/null 2>&1 || true
    fi
    current="$(git -C "$dest" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$current" != "$commit" ]]; then
      echo "  WARNING: HEAD $current != pinned $commit" >&2
    fi
  fi

  if [[ -n "$subdir" && ! -d "$dest/$subdir" ]]; then
    echo "  WARNING: declared subdir '$subdir' missing" >&2
  fi
  ok=$((ok + 1))
done < "$TSV"

echo
echo "Corpus materialized under $REPOS"
echo "total=$total fetched=$ok already-present=$skipped failed=$failed"
if [[ "$failed" -gt 0 ]]; then
  exit 2
fi
