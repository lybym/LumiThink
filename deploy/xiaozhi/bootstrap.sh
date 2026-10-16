#!/usr/bin/env bash
# E2E-04 (issue #54) — 从干净 Linux 环境部署钉死版本的小智服务端（gateway-minimal 档位）。
#
# 步骤：读取 version.env 钉死值 → 浅克隆 pinned commit（校验 SHA）→ python venv
# → 安装 requirements-gateway-minimal.txt（上游 pin 的子集，理由见文件头）→
# 渲染 data/.config.yaml（fail-closed secret 注入）。启动方式见 runbook §2/§5
# （systemd: deploy/xiaozhi/xiaozhi-server.service；CI: 直接 venv python app.py）。
#
# 特权：目标目录父级不可写时内部逐条加 sudo；root 或 CI（$RUNNER_TEMP）下不加。
# 用法（仓库根目录）：
#   sudo bash deploy/xiaozhi/bootstrap.sh \
#     --target /opt/xiaozhi-esp32-server \
#     --env-file /etc/xiaozhi/xiaozhi.env
# 选项：--skip-clone（目标目录已有 pinned checkout 时复用）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=version.env
source "${REPO_ROOT}/deploy/xiaozhi/version.env"

TARGET="/opt/xiaozhi-esp32-server"
ENV_FILE=""
SKIP_CLONE=0
SERVICE_USER="xiaozhi-server"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --skip-clone) SKIP_CLONE=1; shift ;;
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    *) echo "[xiaozhi:bootstrap] unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -n "${XIAOZHI_SERVER_COMMIT}" ] || { echo "[xiaozhi:bootstrap] version.env pin missing" >&2; exit 1; }
# The render step is unconditional (also on --skip-clone re-renders), so the
# env file is always required — fail here with a clear message, not inside
# render_config with an empty path.
[ -n "${ENV_FILE}" ] || { echo "[xiaozhi:bootstrap] --env-file required" >&2; exit 1; }

# Privilege: only escalate when the target location is not writable by us.
SUDO=""
if [ ! -w "$(dirname "${TARGET}")" ]; then
  command -v sudo >/dev/null 2>&1 || { echo "[xiaozhi:bootstrap] need sudo to write ${TARGET}" >&2; exit 1; }
  SUDO="sudo"
fi

SERVER_DIR="${TARGET}/main/xiaozhi-server"
VENV_DIR="${TARGET}/venv"

# --- 1. 钉死 checkout（浅克隆 + SHA 校验；绝不使用浮动 ref）--------------------
if [ "${SKIP_CLONE}" -eq 0 ]; then
  ${SUDO} mkdir -p "${TARGET}"
  if [ ! -d "${TARGET}/.git" ]; then
    ${SUDO} git init "${TARGET}"
    ${SUDO} git -C "${TARGET}" remote add origin "https://github.com/${XIAOZHI_SERVER_REPO}.git"
  fi
  ${SUDO} git -C "${TARGET}" fetch --depth 1 origin "${XIAOZHI_SERVER_COMMIT}"
  ${SUDO} git -C "${TARGET}" -c advice.detachedHead=false checkout --detach FETCH_HEAD
  HEAD_SHA="$(${SUDO} git -C "${TARGET}" rev-parse HEAD)"
  if [ "${HEAD_SHA}" != "${XIAOZHI_SERVER_COMMIT}" ]; then
    echo "[xiaozhi:bootstrap] checkout SHA mismatch: ${HEAD_SHA} != ${XIAOZHI_SERVER_COMMIT}" >&2
    exit 1
  fi
  echo "[xiaozhi:bootstrap] pinned checkout OK @ ${HEAD_SHA:0:12}"
else
  HEAD_SHA="$(${SUDO} git -C "${TARGET}" rev-parse HEAD)"
  [ "${HEAD_SHA}" = "${XIAOZHI_SERVER_COMMIT}" ] || {
    echo "[xiaozhi:bootstrap] --skip-clone but SHA drifted: ${HEAD_SHA}" >&2
    exit 1
  }
fi

# --- 2. python 版本钉死 + venv -------------------------------------------------
PY="${XIAOZHI_SERVER_PYTHON}"
PY_BIN="python${PY}"
command -v "${PY_BIN}" >/dev/null 2>&1 || PY_BIN=python3
ACTUAL="$("${PY_BIN}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [ "${ACTUAL}" != "${PY}" ]; then
  echo "[xiaozhi:bootstrap] python ${PY} required (upstream baseline), found ${ACTUAL}" >&2
  exit 1
fi
if [ ! -x "${VENV_DIR}/bin/python" ]; then
  ${SUDO} "${PY_BIN}" -m venv "${VENV_DIR}"
fi
${SUDO} "${VENV_DIR}/bin/pip" install --quiet --upgrade pip
${SUDO} "${VENV_DIR}/bin/pip" install --quiet \
  -r "${REPO_ROOT}/deploy/xiaozhi/requirements-gateway-minimal.txt"
echo "[xiaozhi:bootstrap] gateway-minimal deps installed (${VENV_DIR})"

# --- 3. 系统依赖核验（值无关，缺失即失败并给出 apt 提示）-----------------------
if ! "${VENV_DIR}/bin/python" -c "import ctypes; ctypes.CDLL('libopus.so.0')" 2>/dev/null; then
  echo "[xiaozhi:bootstrap] libopus missing (opuslib_next needs it): sudo apt-get install -y libopus0" >&2
  exit 1
fi
command -v ffmpeg >/dev/null 2>&1 || {
  echo "[xiaozhi:bootstrap] ffmpeg missing (upstream app.py requires it): sudo apt-get install -y ffmpeg" >&2
  exit 1
}
echo "[xiaozhi:bootstrap] system deps OK (libopus0, ffmpeg)"

# --- 4. 渲染配置（fail-closed；0600；root 执行时产物/目录归属 = 服务用户）------
# Ownership contract (review R1 P1-1): os.replace does NOT preserve the
# replaced file's owner, so a root re-render would otherwise leave a
# root:root 0600 config the service user cannot read (crash-loop on the
# SECOND config change). When running as root — the systemd path — every
# render re-applies the service-user owner to the file AND the data/tmp dirs
# (the unit also writes tmp/server.log and data/bin as that user).
RENDER_OWNER_ARGS=()
if [ "$(id -u)" -eq 0 ]; then
  getent passwd "${SERVICE_USER}" >/dev/null 2>&1 || {
    echo "[xiaozhi:bootstrap] service user ${SERVICE_USER} missing (runbook §2 step 0)" >&2
    exit 1
  }
  RENDER_OWNER_ARGS=(--owner "${SERVICE_USER}")
fi
${SUDO} mkdir -p "${SERVER_DIR}/data" "${SERVER_DIR}/tmp"
${SUDO} "${VENV_DIR}/bin/python" "${REPO_ROOT}/deploy/xiaozhi/render_config.py" \
  --template "${REPO_ROOT}/deploy/xiaozhi/config/gateway-minimal.yaml" \
  --env-file "${ENV_FILE}" \
  --output "${SERVER_DIR}/data/.config.yaml" \
  "${RENDER_OWNER_ARGS[@]+${RENDER_OWNER_ARGS[@]}}"
${SUDO} chmod 755 "${SERVER_DIR}/data" "${SERVER_DIR}/tmp"
if [ "$(id -u)" -eq 0 ]; then
  ${SUDO} chown -R "${SERVICE_USER}:${SERVICE_USER}" \
    "${SERVER_DIR}/data" "${SERVER_DIR}/tmp"
fi

echo "[xiaozhi:bootstrap] done. next: runbook §2 (systemd install) or §5 (CI-style foreground start)"
