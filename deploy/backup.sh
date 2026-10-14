#!/usr/bin/env bash
# LumiThink R1-08 backup drill — copy the ENCRYPTED snapshot (and any SQLite
# file, should a future persistence decision introduce one) into a dated,
# mode-0600 archive. The snapshot is already AES-256-GCM encrypted at rest;
# the copy stays ciphertext end-to-end. Optionally verifies readability with
# the snapshot CLI before declaring the drill successful.
#
# Usage: deploy/backup.sh [--verify] [archive-dir]
set -euo pipefail

SNAPSHOT_PATH="${LUMITHINK_SNAPSHOT_PATH:-/var/lib/lumithink/snapshot.bin}"
KEY_FILE="${LUMITHINK_SNAPSHOT_KEY_FILE:-}"
KEY_HEX="${LUMITHINK_SNAPSHOT_KEY:-}"
APP_DIR="${LUMITHINK_APP_DIR:-/opt/lumithink}"
SQLITE_PATH="${LUMITHINK_SQLITE_PATH:-}"   # future persistence decision
ARCHIVE_DIR="${2:-/var/backups/lumithink}"
VERIFY="${1:-}"

fail() { echo "[lumithink:backup] $1" >&2; exit 1; }

[ -f "${SNAPSHOT_PATH}" ] || fail "snapshot file ${SNAPSHOT_PATH} missing (nothing to back up yet)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${ARCHIVE_DIR}"
umask 077

cp "${SNAPSHOT_PATH}" "${ARCHIVE_DIR}/snapshot-${stamp}.bin"
chmod 600 "${ARCHIVE_DIR}/snapshot-${stamp}.bin"

if [ -n "${SQLITE_PATH}" ] && [ -f "${SQLITE_PATH}" ]; then
  cp "${SQLITE_PATH}" "${ARCHIVE_DIR}/database-${stamp}.db"
  chmod 600 "${ARCHIVE_DIR}/database-${stamp}.db"
fi

if [ "${VERIFY}" = "--verify" ]; then
  key_args=()
  if [ -n "${KEY_FILE}" ]; then key_args=(--key-file "${KEY_FILE}");
  elif [ -n "${KEY_HEX}" ]; then key_args=(--key-hex "${KEY_HEX}");
  else fail "no snapshot key available for --verify"; fi
  node --experimental-strip-types "${APP_DIR}/scripts/snapshot-cli.ts" verify \
    "${ARCHIVE_DIR}/snapshot-${stamp}.bin" "${key_args[@]}"
fi

echo "${ARCHIVE_DIR}/snapshot-${stamp}.bin"
