#!/usr/bin/env bash
# E2E-04 (issue #54) — 小智私有服务端健康检查。
# Exit 0 iff: (1) OTA HTTP 口 POST /xiaozhi/ota/ 返回 200 且 JSON 含 websocket
# 下发面；(2) 8000/8003 只绑定 127.0.0.1（公网面归 Caddy）；(3) 模拟设备
# probe_hello.py 完成 v2.5.2 hello ack + abort→tts stop 线协议断言。
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
probe_ok=""
for attempt in 1 2 3 4 5; do
  if probe --with-abort >/dev/null 2>&1; then
    probe_ok="1"
    break
  fi
  sleep 2
done
if [ -z "${probe_ok}" ]; then
  probe --with-abort   # 最后一次不带重定向，让失败原因可见
  exit 1
fi
echo "[xiaozhi:health] simulated-device hello + abort OK"
echo "[xiaozhi:health] healthy"
