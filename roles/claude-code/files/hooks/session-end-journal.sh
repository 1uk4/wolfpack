#!/usr/bin/env bash
# Claude Code Stop hook — appends a session-ended marker to today's daily log.
# Creates the daily file from template frontmatter if it doesn't exist.
# Always exits 0 so a hook failure never blocks session shutdown.

set -u

DEN="${CLAUDE_PROJECT_DIR:-${HOME}/workspace/den}"
DAILY_DIR="${DEN}/memory/daily"
DATE="$(date -u +%Y-%m-%d)"
TIME="$(date -u +%H:%MZ)"
FILE="${DAILY_DIR}/${DATE}.md"

WOLF="unknown"
if [ -r "${DEN}/config.yml" ]; then
  WOLF="$(awk -F': *' '/^wolf:/ {print $2; exit}' "${DEN}/config.yml" 2>/dev/null || echo unknown)"
fi
[ -z "${WOLF}" ] && WOLF="unknown"

mkdir -p "${DAILY_DIR}" || exit 0

if [ ! -f "${FILE}" ]; then
  cat > "${FILE}" <<EOF
---
date: ${DATE}
wolf: ${WOLF}
summary: ""
tags: [daily]
---

# ${WOLF} — ${DATE}

## Sessions

EOF
fi

printf -- '- %s session ended\n' "${TIME}" >> "${FILE}"

exit 0
