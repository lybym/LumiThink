#!/usr/bin/env bash
# LumiThink R1-08 health check (issue #20 交付范围 1). Exit 0 iff the app
# answers /api/health with status ok and the armed legacy domain guard.
set -euo pipefail

BASE_URL="${LUMITHINK_HEALTH_URL:-http://127.0.0.1:3000}"
TIMEOUT="${LUMITHINK_HEALTH_TIMEOUT:-30}"

deadline=$(( $(date +%s) + TIMEOUT ))
while [ "$(date +%s)" -lt "${deadline}" ]; do
  if body="$(curl -fsS "${BASE_URL}/api/health" 2>/dev/null)"; then
    echo "${body}"
    echo "${body}" | grep -q '"status":"ok"' || { echo "[lumithink:health] status not ok" >&2; exit 1; }
    echo "${body}" | grep -q '"legacyDomainGuard":"armed"' || { echo "[lumithink:health] legacy guard not armed" >&2; exit 1; }
    exit 0
  fi
  sleep 1
done
echo "[lumithink:health] not healthy within ${TIMEOUT}s" >&2
exit 1
