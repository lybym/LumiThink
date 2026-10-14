#!/usr/bin/env bash
# LumiThink R1-08 constrained start (issue #20 交付范围 1: 启动/健康检查).
# Preflight: env file exists + mode 600, build output present, startup env
# validates fail-closed — then exec the server on LOOPBACK ONLY (public
# exposure is the TLS proxy's job).
set -euo pipefail

APP_DIR="${LUMITHINK_APP_DIR:-/opt/lumithink}"
ENV_FILE="${LUMITHINK_ENV_FILE:-/etc/lumithink/lumithink.env}"
PORT="${PORT:-3000}"

fail() { echo "[lumithink:start] $1" >&2; exit 1; }

[ -d "${APP_DIR}" ] || fail "app dir ${APP_DIR} not present"
[ -f "${APP_DIR}/.next/BUILD_ID" ] || fail "production build missing (run: pnpm run build in a release dir)"
[ -f "${ENV_FILE}" ] || fail "env file ${ENV_FILE} missing"
perms="$(stat -c '%a' "${ENV_FILE}")"
[ "${perms}" = "600" ] || fail "env file ${ENV_FILE} must be mode 600 (got ${perms})"

# Fail-closed configuration check BEFORE exec (secrets/snapshot shapes; the
# validator never echoes values).
cd "${APP_DIR}"
node --experimental-strip-types scripts/check-startup-env.ts || fail "startup environment invalid"

exec ./node_modules/.bin/next start -H 127.0.0.1 -p "${PORT}"
