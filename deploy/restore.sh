#!/usr/bin/env bash
# LumiThink R1-08 restore drill — place an archived ENCRYPTED snapshot back
# at the live snapshot path and enable the post-restore deletion replay so a
# restore can NEVER resurrect deleted data (ADR-0005; issue #20 AC 2).
#
# The replay flag (LUMITHINK_SNAPSHOT_RESTORE_REPLAY=1) is set here BECAUSE
# an archive may predate later erases; the runtime replays the deletion
# ledger once after the boot restore. Normal restarts (no restore.sh) keep
# the flag off so confirmed events are preserved.
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

# 3. Enable the post-restore deletion replay in the env file (idempotent).
if grep -q '^LUMITHINK_SNAPSHOT_RESTORE_REPLAY=' "${ENV_FILE}"; then
  sed -i 's/^LUMITHINK_SNAPSHOT_RESTORE_REPLAY=.*/LUMITHINK_SNAPSHOT_RESTORE_REPLAY=1/' "${ENV_FILE}"
else
  printf '\n# Set by restore.sh: replay the deletion ledger after boot restore.\nLUMITHINK_SNAPSHOT_RESTORE_REPLAY=1\n' >> "${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

echo "[lumithink:restore] archive placed; restart the service (systemctl restart lumithink)."
echo "[lumithink:restore] The runtime will restore, replay deletions once, then clear the flag is NOT automatic — unset it afterwards:"
echo "[lumithink:restore]   sed -i 's/^LUMITHINK_SNAPSHOT_RESTORE_REPLAY=.*/LUMITHINK_SNAPSHOT_RESTORE_REPLAY=0/' ${ENV_FILE}"
