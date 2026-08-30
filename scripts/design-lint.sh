#!/usr/bin/env bash
# design-lint.sh — Swiss restyle design system lint gate.
#
# Ported from /Users/teddy/Dev/github/18-agent-builder/deep-agent-builder-frontend/scripts/design-lint.sh
# (lines 23-55: the `|| true` guard pattern that keeps a clean tree from
# tripping `set -e`/`pipefail` when grep finds no matches).
set -euo pipefail

echo "=== Canvas Swiss Restyle Design Lint ==="

STATUS=0

# 1. Hardcoded HEX color detection (allowed: #fff / #ffffff — fixed contrast color).
# grep -c would exit non-zero on zero matches under `set -e`, so every grep in
# this pipeline is guarded with `|| true` to keep a clean tree from failing.
HARDCODED_HEX=$(grep -rnE '#[0-9a-fA-F]{3,8}\b' apps/web/app apps/web/components \
  --include='*.tsx' --include='*.css' 2>/dev/null \
  | grep -ivE '#fff(fff)?\b' || true)

if [ -n "$HARDCODED_HEX" ]; then
  echo "FAIL: Hardcoded HEX colors found (only #fff/#ffffff is allowed):"
  echo "$HARDCODED_HEX"
  STATUS=1
else
  echo "PASS: No disallowed hardcoded HEX colors found."
fi

# 2. prefers-color-scheme must not appear in canvas.css (light-only, no OS dark-mode override).
PREFERS_COLOR_SCHEME_COUNT=$(grep -c 'prefers-color-scheme' packages/canvas-react/src/styles/canvas.css 2>/dev/null || true)
PREFERS_COLOR_SCHEME_COUNT=${PREFERS_COLOR_SCHEME_COUNT:-0}

if [ "$PREFERS_COLOR_SCHEME_COUNT" -ne 0 ]; then
  echo "FAIL: prefers-color-scheme found in packages/canvas-react/src/styles/canvas.css ($PREFERS_COLOR_SCHEME_COUNT occurrence(s))."
  STATUS=1
else
  echo "PASS: canvas.css has no prefers-color-scheme references."
fi

echo "=== Summary ==="
if [ "$STATUS" -eq 0 ]; then
  echo "=== Design System Lint PASSED ==="
else
  echo "=== Design System Lint FAILED ==="
fi

exit "$STATUS"
