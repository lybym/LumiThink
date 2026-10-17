#!/usr/bin/env python3
# E2E-07 (issue #57) — 本地回环 TTS stub（CI/联调用，非生产路径）。
#
# CustomTTS 档位（deploy/xiaozhi/config/gateway-bridge.yaml）POST
# {"input": "<句子>"} 到本 stub；返回一段确定性 WAV（正弦短句音，16 kHz
# 单声道）。上游 TTS base 用 ffmpeg 转 Opus 后按协议下发设备——本 stub
# 只提供确定的音频字节来源，让 hello→(文字)→DSH→TTS→Opus→stop 的端到端
# 链路在零外发条件下可证明。仅绑定 127.0.0.1。
#
# 用法：python3 deploy/xiaozhi/tts_stub.py --port 8097

import argparse
import math
import struct
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def wav_bytes(duration_s: float = 0.6, freq_hz: int = 440) -> bytes:
    rate = 16000
    n = int(rate * duration_s)
    pcm = b"".join(
        struct.pack("<h", int(0.35 * 32767 * math.sin(2 * math.pi * freq_hz * i / rate)))
        for i in range(n)
    )
    header = b"RIFF"
    header += struct.pack("<I", 36 + len(pcm))
    header += b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(pcm))
    return header + pcm


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server API)
        length = int(self.headers.get("content-length", "0") or "0")
        if length:
            _ = self.rfile.read(length)  # the sentence text is never logged
        body = wav_bytes()
        self.send_response(200)
        self.send_header("content-type", "audio/wav")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Content-free readiness line only.
        sys.stderr.write("[tts-stub] %s\n" % (fmt % args))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8097)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    sys.stderr.write(f"[tts-stub] listening on 127.0.0.1:{args.port}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
