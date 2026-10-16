#!/usr/bin/env python3
"""E2E-07 (issue #57): protocol-simulated device probe for the WIRED
xiaozhi↔LumiThink loop (real pinned server + real gateway/DSH processes).

Modes (mutually exclusive):
  default (--expect-full-loop)   hello -> session -> listen detect (text, the
                                 simulated device's utterance) -> assert the
                                 stt echo + tts start + sentence_start +
                                 REAL binary Opus downlink frames + tts stop.
                                 The ONLY selected LLM is the LumiThink
                                 gateway bridge: a timeout here means the
                                 wiring is broken (the built-in AI second
                                 path is structurally unreachable —
                                 selected_module.LLM is the bridge and
                                 read_config_from_api is false).
  --expect-duplicate-refusal     two connections with the SAME device-id: the
                                 second must be closed by the server edge
                                 (the gateway's device_drop enforcement of
                                 the Adapter connection lease) while the
                                 first keeps working.
  --expect-abort-fence           mid-playback abort: tts stop arrives, and no
                                 sentence/audio follows it (late-audio /
                                 stop-后音频帧 fence, server-side
                                 client_abort + gateway epoch fence).

PRIVACY: sentence texts are counted, never printed; audio bytes are only
counted. Output is content-free.
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import os
import ssl
import sys
import time

import websockets


def generate_token(secret, client_id, device_id, ts=None):
    ts = int(time.time()) if ts is None else int(ts)
    content = f"{client_id}|{device_id}|{ts}"
    digest = hmac.new(
        secret.encode("utf-8"), content.encode("utf-8"), hashlib.sha256
    ).digest()
    signature = base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    return f"{signature}.{ts}"


def build_hello():
    return json.dumps(
        {
            "type": "hello",
            "version": 1,
            "features": {"mcp": False, "aec": False},
            "transport": "websocket",
            "audio_params": {
                "format": "opus",
                "sample_rate": 16000,
                "channels": 1,
                "frame_duration": 60,
            },
        },
        ensure_ascii=False,
    )


async def connect(args, device_id, client_id, token):
    tls = None
    if args.url.startswith("wss"):
        tls = ssl._create_unverified_context() if args.insecure else ssl.create_default_context()
    headers = {"Device-Id": device_id, "Client-Id": client_id, "Authorization": f"Bearer {token}"}
    return await websockets.connect(
        args.url,
        additional_headers=headers,
        ssl=tls,
        open_timeout=args.timeout,
        close_timeout=5,
    )


async def recv_msg(ws, timeout):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return raw


async def hello_phase(ws, timeout):
    await ws.send(build_hello())
    raw = await recv_msg(ws, timeout)
    if isinstance(raw, bytes):
        raise AssertionError("received binary before hello ack")
    ack = json.loads(raw)
    if ack.get("type") != "hello":
        raise AssertionError(f"hello ack type mismatch: {ack.get('type')!r}")
    session_id = ack.get("session_id")
    if not session_id:
        raise AssertionError("hello ack carries no session_id")
    return session_id


class TurnCollector:
    """Content-free turn accounting: counts only, never stores text."""

    def __init__(self):
        self.stt_echo = 0
        self.tts_start = 0
        self.tts_stop = 0
        self.sentence_starts = 0
        self.audio_frames = 0
        self.saw_stop_after_audio = False

    def summary(self):
        return (
            f"stt_echo={self.stt_echo} tts_start={self.tts_start} "
            f"sentence_starts={self.sentence_starts} audio_frames={self.audio_frames} "
            f"tts_stop={self.tts_stop}"
        )


async def collect_until_stop(ws, collector, timeout, stop_on_first_stop=True):
    """Read frames until the turn's tts stop (or timeout)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            raw = await recv_msg(ws, max(0.05, remaining))
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            return False
        if isinstance(raw, bytes):
            collector.audio_frames += 1
            continue
        message = json.loads(raw)
        kind = message.get("type")
        state = message.get("state")
        if kind == "stt":
            collector.stt_echo += 1
        elif kind == "tts" and state == "start":
            collector.tts_start += 1
        elif kind == "tts" and state == "sentence_start":
            collector.sentence_starts += 1
        elif kind == "tts" and state == "stop":
            collector.tts_stop += 1
            if collector.audio_frames > 0 or collector.sentence_starts > 0:
                collector.saw_stop_after_audio = True
            if stop_on_first_stop:
                return True
    return False


async def probe_full_loop(args):
    token = generate_token(args.auth_key, args.client_id, args.device_id)
    async with await connect(args, args.device_id, args.client_id, token) as ws:
        session_id = await hello_phase(ws, args.timeout)
        print(f"hello OK session_id={session_id}")
        # The simulated utterance: the device's listen detect carrying text
        # (the same LLM entry the ASR final path takes: startToChat -> chat).
        await ws.send(json.dumps({"type": "listen", "state": "detect", "mode": "manual", "text": args.text}))
        collector = TurnCollector()
        finished = await collect_until_stop(ws, collector, args.turn_timeout)
        if not finished:
            raise AssertionError(
                f"wired turn did not complete within {args.turn_timeout}s: {collector.summary()} "
                "(no built-in AI fallback exists — a timeout is a wiring failure)"
            )
        if collector.stt_echo < 1:
            raise AssertionError(f"no stt echo (startToChat path broken): {collector.summary()}")
        if collector.tts_start < 1 or collector.sentence_starts < 1:
            raise AssertionError(f"no TTS stream: {collector.summary()}")
        if collector.audio_frames < 1:
            raise AssertionError(
                f"no REAL downlink Opus frames (the frameCount/digest placeholder is not resolved): {collector.summary()}"
            )
        print(f"full-loop OK (DSH answered, real Opus delivered): {collector.summary()}")


async def probe_duplicate_refusal(args):
    token = generate_token(args.auth_key, args.client_id, args.device_id)
    async with await connect(args, args.device_id, args.client_id, token) as first:
        await hello_phase(first, args.timeout)
        async with await connect(args, args.device_id, args.client_id, token) as second:
            await hello_phase(second, args.timeout)
            # The gateway refuses the second connection (Adapter lease) and
            # orders the bridge to close the device WebSocket.
            second_closed = False
            try:
                while True:
                    raw = await recv_msg(second, args.timeout)
                    if isinstance(raw, str) and json.loads(raw).get("type") == "tts":
                        continue  # playback state frames are not a refusal
            except websockets.ConnectionClosed:
                second_closed = True
            except asyncio.TimeoutError:
                second_closed = False
            if not second_closed:
                raise AssertionError("duplicate device connection was not closed by the server edge")
            print("duplicate-refusal OK (second connection closed, lease enforced)")
        # The first connection keeps working: a full turn still completes.
        await first.send(json.dumps({"type": "listen", "state": "detect", "mode": "manual", "text": args.text}))
        collector = TurnCollector()
        finished = await collect_until_stop(first, collector, args.turn_timeout)
        if not finished or collector.audio_frames < 1:
            raise AssertionError(f"first connection broken after duplicate refusal: {collector.summary()}")
        print(f"first connection unaffected: {collector.summary()}")


async def probe_abort_fence(args):
    token = generate_token(args.auth_key, args.client_id, args.device_id)
    async with await connect(args, args.device_id, args.client_id, token) as ws:
        await hello_phase(ws, args.timeout)
        await ws.send(json.dumps({"type": "listen", "state": "detect", "mode": "manual", "text": args.text}))
        # Read until the first audio flows (or the turn completes quickly).
        saw_audio = False
        abort_sent = False
        collector = TurnCollector()
        deadline = time.monotonic() + args.turn_timeout
        while time.monotonic() < deadline and collector.tts_stop == 0:
            raw = await recv_msg(ws, args.timeout)
            if isinstance(raw, bytes):
                saw_audio = True
                collector.audio_frames += 1
                if saw_audio and not abort_sent:
                    # Mid-playback abort (wire `abort` == the issue's
                    # client_abort; VOICE_GATEWAY_PROTOCOL §1 terminology).
                    await ws.send(json.dumps({"type": "abort"}))
                    abort_sent = True
                continue
            message = json.loads(raw)
            kind = message.get("type")
            state = message.get("state")
            if kind == "tts" and state == "sentence_start":
                collector.sentence_starts += 1
            elif kind == "tts" and state == "start":
                collector.tts_start += 1
            elif kind == "tts" and state == "stop":
                collector.tts_stop += 1
        if collector.tts_stop == 0:
            raise AssertionError(f"turn never stopped: {collector.summary()}")
        # After the stop, NO further sentence or audio may arrive
        # (late-audio / stop-后音频帧 fence).
        late = 0
        try:
            while True:
                raw = await recv_msg(ws, args.late_window)
                if isinstance(raw, bytes):
                    late += 1
                elif json.loads(raw).get("type") == "tts" and json.loads(raw).get("state") == "sentence_start":
                    late += 1
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
        if late > 0:
            raise AssertionError(f"{late} late frames after the abort stop (stale epoch leak)")
        print(f"abort-fence OK (stop effective, zero late frames): {collector.summary()}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--device-id", default="aa:bb:cc:dd:ee:07")
    parser.add_argument("--client-id", default="e2e07-probe")
    parser.add_argument("--auth-key", default=None, help="default: env XIAOZHI_AUTH_KEY")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--turn-timeout", type=float, default=45.0)
    parser.add_argument("--late-window", type=float, default=2.0)
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument(
        "--text",
        default="我们来玩个游戏好不好",
        help="simulated utterance (a clearly synthetic child-safe sample)",
    )
    parser.add_argument("--expect-full-loop", action="store_true", default=True)
    parser.add_argument("--expect-duplicate-refusal", action="store_true")
    parser.add_argument("--expect-abort-fence", action="store_true")
    args = parser.parse_args()

    secret = args.auth_key or os.environ.get("XIAOZHI_AUTH_KEY")
    if not secret:
        raise SystemExit("[xiaozhi:probe] missing --auth-key/XIAOZHI_AUTH_KEY")
    args.auth_key = secret

    if args.expect_duplicate_refusal:
        asyncio.run(probe_duplicate_refusal(args))
        return 0
    if args.expect_abort_fence:
        asyncio.run(probe_abort_fence(args))
        return 0
    asyncio.run(probe_full_loop(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
