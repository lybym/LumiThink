#!/usr/bin/env bash
# LumiThink R1-08 restore drill — place an archived ENCRYPTED snapshot back
# at the live snapshot path and request the one-shot post-restore deletion
# replay so a restore can NEVER resurrect deleted data (ADR-0005; issue #20
# AC 2).
#
# The replay is requested with a SELF-CLEARING PENDING MARKER FILE
# (<snapshot-dir>/restore-replay.pending), NOT with a persistent env flag:
# the runtime consumes (deletes) the marker during the one replaying boot,
# so a missed manual reset can never turn later restarts into purges of
# newly created confirmed data (review P1-1). Any leftover
# LUMITHINK_SNAPSHOT_RESTORE_REPLAY=1 from an OLDER restore.sh version is
# neutralized here as well.
#
# Usage: sudo deploy/restore.sh <archive-snapshot.bin>
set -euo pipefail

SNAPSHOT_PATH="${LUMITHINK_SNAPSHOT_PATH:-/var/lib/lumithink/snapshot.bin}"
ENV_FILE="${LUMITHINK_ENV_FILE:-/etc/lumithink/lumithink.env}"
KEY_FILE="${LUMITHINK_SNAPSHOT_KEY_FILE:-}"
KEY_HEX="${LUMITHINK_SNAPSHOT_KEY:-}"
APP_DIR="${LUMITHINK_APP_DIR:-/opt/lumithink}"

fail() { echo "[lumithink:restore] $1" >&2; exit 1; }

[ "$#" -eq 1 ] || fail "usage: restore.sh <archive-snapshot.bin>"
ARCHIVE="$1"
[ -f "${ARCHIVE}" ] || fail "archive ${ARCHIVE} not found"
[ -f "${ENV_FILE}" ] || fail "env file ${ENV_FILE} missing"

key_args=()
if [ -n "${KEY_FILE}" ]; then key_args=(--key-file "${KEY_FILE}");
elif [ -n "${KEY_HEX}" ]; then key_args=(--key-hex "${KEY_HEX}");
else fail "no snapshot key available (set LUMITHINK_SNAPSHOT_KEY(_FILE))"; fi

# 1. Verify the archive decrypts + validates BEFORE touching the live file.
node --experimental-strip-types "${APP_DIR}/scripts/snapshot-cli.ts" verify "${ARCHIVE}" "${key_args[@]}"

# 2. Keep the current file (rollback point) and place the archive atomically.
umask 077
if [ -f "${SNAPSHOT_PATH}" ]; then
  cp "${SNAPSHOT_PATH}" "${SNAPSHOT_PATH}.pre-restore"
  chmod 600 "${SNAPSHOT_PATH}.pre-restore"
fi
install -m 600 "${ARCHIVE}" "${SNAPSHOT_PATH}.incoming"
mv -f "${SNAPSHOT_PATH}.incoming" "${SNAPSHOT_PATH}"

# 3. Request the one-shot post-restore deletion replay with the pending
#    marker (0600, next to the snapshot; the runtime deletes it after the
#    replaying boot's restore + replay + persist succeeded).
MARKER="$(dirname "${SNAPSHOT_PATH}")/restore-replay.pending"
: > "${MARKER}"
chmod 600 "${MARKER}"

# 4. Legacy cleanup (review P1-1): neutralize any persistent env flag an
#    OLDER restore.sh left behind — with the marker mechanism in place, a
#    leftover =1 would replay (and purge newly created data) on EVERY
#    restart. The rewrite is ALWAYS echoed (review round-2 P2-2): a
#    deliberate operator override must not be silently rewritten.
if grep -q '^LUMITHINK_SNAPSHOT_RESTORE_REPLAY=' "${ENV_FILE}"; then
  sed -i 's/^LUMITHINK_SNAPSHOT_RESTORE_REPLAY=.*/LUMITHINK_SNAPSHOT_RESTORE_REPLAY=0/' "${ENV_FILE}"
  echo "[lumithink:restore] Rewrote a LUMITHINK_SNAPSHOT_RESTORE_REPLAY override in ${ENV_FILE} to =0 (the replay request is now carried by the marker file). If you set =1 deliberately for a diagnostic window, re-apply it AFTER this run and clear it right after."
fi

echo "[lumithink:restore] archive placed; restart the service (systemctl restart lumithink)."
echo "[lumithink:restore] The NEXT boot restores the archive, replays the deletion ledger ONCE, then clears the marker automatically."
echo "[lumithink:restore] Every later restart without a new restore.sh run is a normal boot: newly created data survives."
