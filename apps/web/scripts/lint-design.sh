#!/usr/bin/env bash
# Adapted from modern-frontend-design for this Next.js app.
set -u
cd "$(dirname "$0")/.." || exit 1
failed=0
check() {
  local label="$1" pattern="$2" findings
  findings=$(rg -n "$pattern" src -g '*.tsx' -g '*.ts' 2>/dev/null || true)
  if [ -n "$findings" ]; then
    printf 'FAIL %s\n%s\n' "$label" "$findings"
    failed=1
  fi
}
check 'hex colours in components' '#[0-9a-fA-F]{3,8}\b'
check 'native select' '<select\b'
check 'hand-built confirm dialog' 'window\.confirm\('
check 'per-icon stroke width' 'strokeWidth='
check 'colour-name utilities' '\b(bg|text|border|ring)-(slate|gray|blue|purple|teal|green|red|orange)-[0-9]'
if rg -n '#[0-9a-fA-F]{3,8}\b|box-shadow:[^;]*[0-9]+px' src/app/styles.css; then
  printf 'FAIL hardcoded colour or shadow in stylesheet\n'
  failed=1
fi
if [ "$failed" -eq 0 ]; then printf 'Design lint passed\n'; fi
exit "$failed"
