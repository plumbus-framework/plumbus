#!/usr/bin/env bash
set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for pkg in plumbus-core ui; do
  echo "Bumping $pkg → $BUMP"
  (cd "$ROOT/packages/$pkg" && npm version "$BUMP" --no-git-tag-version)
done

echo "Done."
