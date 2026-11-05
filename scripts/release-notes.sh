#!/usr/bin/env bash
# Release notes: commits since the component's previous tag (or all history if none).
#   scripts/release-notes.sh <component> <tag>   -> markdown on stdout
set -euo pipefail
COMP=${1:?component}; TAG=${2:?tag}
PREV=$(git tag --list "$COMP/v[0-9]*" --sort=-v:refname | grep -vxF "$TAG" | while read -r t; do
  # previous = nearest tag that is an ancestor of this one
  git merge-base --is-ancestor "$t" "$TAG^{commit}" && { echo "$t"; break; }; done || true)
if [ -n "$PREV" ]; then RANGE="$PREV..$TAG"; echo "Changes in \`$COMP\` since \`$PREV\`:"; else RANGE="$TAG"; echo "First release of \`$COMP\`. All commits:"; fi
echo
# GitHub caps a release body at 125000 characters: list at most MAX commits (subjects cut to 200 chars), then a count of the rest.
MAX=${RELEASE_NOTES_MAX:-300}
TOTAL=$(git rev-list --no-merges --count "$RANGE")
git log --no-merges -n "$MAX" --format='- %h %s' "$RANGE" | cut -c1-200
if [ "$TOTAL" -gt "$MAX" ]; then echo "- … and $((TOTAL - MAX)) older commits"; fi
echo
echo "Commit: $(git rev-parse "$TAG^{commit}")"
