#!/usr/bin/env bash
# E2E-04 (issue #54) — 小智私有服务端健康检查。
# Exit 0 iff: (1) OTA HTTP 口 POST /xiaozhi/ota/ 返回 200 且 JSON 含 websocket
# 下发面，且服务端【签发】的 device token 存在；(2) 8000/8003 只绑定 127.0.0.1
# （公网面归 Caddy）；(3) 模拟设备 probe_hello.py 完成 v2.5.2 hello ack +
# abort→tts stop 线协议断言；(4) OTA 签发的 token 原样重放 WSS 被接受
# （设备真实取 token 路径，review R1 test-gap 1；自铸 token 路径由 (3) 覆盖）。
# 全部为值无关断言；不打印 token/密钥。
set -euo pipefail

XIAOZHI_OTA_URL="${XIAOZHI_OTA_URL:-http://127.0.0.1:8003}"
XIAOZHI_WS_URL="${XIAOZHI_WS_URL:-ws://127.0.0.1:8000/xiaozhi/v1/}"
XIAOZHI_PYTHON="${XIAOZHI_PYTHON:-python3}"
XIAOZHI_HEALTH_TIMEOUT="${XIAOZHI_HEALTH_TIMEOUT:-60}"
XIAOZHI_HEALTH_PROBE_DIR="${XIAOZHI_HEALTH_PROBE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
XIAOZHI_DEVICE_ID="${XIAOZHI_DEVICE_ID:-aa:bb:cc:dd:ee:ff}"
XIAOZHI_CLIENT_ID="${XIAOZHI_CLIENT_ID:-healthcheck-client}"
# 模拟设备的 HMAC token 由本脚本现场计算（要求注入 XIAOZHI_AUTH_KEY）；
# 值永不回显。
: "${XIAOZHI_AUTH_KEY:?XIAOZHI_AUTH_KEY must be set (hex, matches server auth_key)}"

probe() {
  local extra=("$@")
  XIAOZHI_AUTH_KEY="${XIAOZHI_AUTH_KEY}" \
  "${XIAOZHI_PYTHON}" "${XIAOZHI_HEALTH_PROBE_DIR}/probe_hello.py" \
    --url "${XIAOZHI_WS_URL}" \
    --device-id "${XIAOZHI_DEVICE_ID}" \
    --client-id "${XIAOZHI_CLIENT_ID}" \
    "${extra[@]}"
}

deadline=$(( $(date +%s) + XIAOZHI_HEALTH_TIMEOUT ))
ota_body=""
while [ "$(date +%s)" -lt "${deadline}" ]; do
  if ota_body="$(curl -fsS -X POST "${XIAOZHI_OTA_URL}/xiaozhi/ota/" \
      -H "device-id: ${XIAOZHI_DEVICE_ID}" \
      -H "client-id: ${XIAOZHI_CLIENT_ID}" \
      -H 'content-type: application/json' -d '{}' 2>/dev/null)"; then
    break
  fi
  sleep 1
done
if [ -z "${ota_body}" ]; then
  echo "[xiaozhi:health] OTA endpoint not reachable within ${XIAOZHI_HEALTH_TIMEOUT}s" >&2
  exit 1
fi
echo "${ota_body}" | grep -q '"websocket"' || {
  echo "[xiaozhi:health] OTA response carries no websocket grant" >&2
  exit 1
}
echo "[xiaozhi:health] OTA endpoint OK (value-free check)"

# 服务端签发的 device token（上游 OTA 响应形状：websocket{url,token}）。
# 设备真实路径 = 设备持该 token 连 WSS；这里原样重放验证签发→鉴权整条回路。
# 值只进子进程参数，永不回显；缺失即 fail-closed（鉴权开启时服务端必签发）。
ota_token="$(printf '%s' "${ota_body}" | "${XIAOZHI_PYTHON}" -c \
  'import json,sys; print(json.load(sys.stdin).get("websocket",{}).get("token",""))')"
[ -n "${ota_token}" ] || {
  echo "[xiaozhi:health] OTA grant carries no issued device token" >&2
  exit 1
}

# 公网暴露负例（AC 3 端口扫描的机器面）：两个服务端口都必须只在回环。
# 公网面唯一入口 = Caddy 443（deploy/xiaozhi/caddy/Caddyfile.xiaozhi）。
loopback_violations="$(ss -ltn | awk 'NR>1 {print $4}' | grep -E ':(8000|8003)$' | grep -v '^127\.0\.0\.1' || true)"
if [ -n "${loopback_violations}" ]; then
  echo "[xiaozhi:health] port 8000/8003 bound beyond loopback (fail-closed):" >&2
  echo "${loopback_violations}" >&2
  exit 1
fi
bound="$(ss -ltn | awk 'NR>1 {print $4}' | grep -cE '^127\.0\.0\.1:(8000|8003)$')"
if [ "${bound}" -lt 2 ]; then
  echo "[xiaozhi:health] expected 127.0.0.1:8000 and 127.0.0.1:8003 listeners; found ${bound}" >&2
  exit 1
fi
echo "[xiaozhi:health] loopback-only binding OK (8000/8003)"

# 探针带小重试环：OTA HTTP 与 WS bind 的就绪存在毫秒级竞态，避免单次探测抖动。
# abort 断言是默认模式（--without-abort 才关闭），无需传参。
probe_ok=""
for attempt in 1 2 3 4 5; do
  if probe >/dev/null 2>&1; then
    probe_ok="1"
    break
  fi
  sleep 2
done
if [ -z "${probe_ok}" ]; then
  probe   # 最后一次不带重定向，让失败原因可见
  exit 1
fi
echo "[xiaozhi:health] simulated-device hello + abort OK"

# OTA 签发 token 重放（同 device-id/client-id——token 绑定该二元组签名）。
# hello ack 即可（线协议 abort 已由上一探针覆盖）。
token_probe() {
  "${XIAOZHI_PYTHON}" "${XIAOZHI_HEALTH_PROBE_DIR}/probe_hello.py" \
    --url "${XIAOZHI_WS_URL}" \
    --device-id "${XIAOZHI_DEVICE_ID}" \
    --client-id "${XIAOZHI_CLIENT_ID}" \
    --token "${ota_token}" \
    --without-abort
}
token_ok=""
for attempt in 1 2 3; do
  if token_probe >/dev/null 2>&1; then
    token_ok="1"
    break
  fi
  sleep 2
done
if [ -z "${token_ok}" ]; then
  token_probe   # 最后一次不带重定向，让失败原因可见
  exit 1
fi
echo "[xiaozhi:health] OTA-issued token accepted over WSS"
echo "[xiaozhi:health] healthy"
