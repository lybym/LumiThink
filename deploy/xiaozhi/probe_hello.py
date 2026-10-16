#!/usr/bin/env python3
"""E2E-04 (issue #54): simulated xiaozhi v2.5.2 device probe.

Modes (mutually exclusive):
  default                 hello -> assert hello ack (session_id), then abort ->
                          assert {"type":"tts","state":"stop"} (the pinned
                          server's abort line contract, VOICE_GATEWAY_PROTOCOL
                          §1 terminology note), then close cleanly.
  --expect-auth-failure   no/invalid token -> assert the server answers the
                          plain-text refusal ("认证失败") and closes.
  --expect-silent-binary  junk binary audio must never be answered with
                          content and must never crash the server (no-reply
                          with the face alive, or a clean close — both are
                          fail-closed outcomes).

The token is generated exactly like the pinned server's core/auth.py
(HMAC-SHA256 over "client_id|device_id|ts", urlsafe-b64, trailing '='s
stripped, appended ".ts"). Requires the server to have been booted with the
matching XIAOZHI_AUTH_KEY.
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
    signature = (
        base64.urlsafe_b64encode(digest).decode("utf-8").rstrip("=")
    )
    return f"{signature}.{ts}"


def build_hello():
    # v2.5.2 firmware hello shape (docs/websocket.md @ tag v2.5.2): uplink
    # 16 kHz mono opus, 60 ms frames — the negotiation baseline the Adapter
    # contract pins (lib/domain/voice/adapter/protocol.ts).
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


async def connect(args, extra_headers):
    tls = None
    if args.url.startswith("wss"):
        tls = ssl._create_unverified_context() if args.insecure else ssl.create_default_context()
    return await websockets.connect(
        args.url,
        additional_headers=extra_headers,
        ssl=tls,
        open_timeout=args.timeout,
        close_timeout=5,
    )


async def recv_json(ws, timeout):
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    if not isinstance(raw, str):
        raise AssertionError(f"expected a text frame, got {len(raw)} binary bytes")
    return json.loads(raw)


async def probe_positive(args):
    headers = {"Device-Id": args.device_id, "Client-Id": args.client_id}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
    async with await connect(args, headers) as ws:
        await ws.send(build_hello())
        ack = await recv_json(ws, args.timeout)
        if ack.get("type") != "hello":
            raise AssertionError(f"hello ack type mismatch: {ack.get('type')!r}")
        session_id = ack.get("session_id")
        if not session_id:
            raise AssertionError("hello ack carries no session_id")
        audio = ack.get("audio_params") or {}
        if audio.get("format") != "opus":
            raise AssertionError(f"downlink audio format unexpected: {audio}")
        print(f"hello OK session_id={session_id} sample_rate={audio.get('sample_rate')}")
        if not args.with_abort:
            return session_id
        # Line-protocol abort check (issue #54 实施范围 3): the wire message is
        # {"type":"abort"}; the server answers tts stop (client_abort semantics).
        await ws.send(json.dumps({"type": "abort"}))
        stop = await recv_json(ws, args.timeout)
        if stop.get("type") != "tts" or stop.get("state") != "stop":
            raise AssertionError(f"abort did not yield tts stop: {stop}")
        if stop.get("session_id") and stop.get("session_id") != session_id:
            raise AssertionError("tts stop session_id mismatch")
        print("abort OK -> tts stop")
        return session_id


async def probe_auth_failure(args):
    headers = {"Device-Id": args.device_id, "Client-Id": args.client_id}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
    async with await connect(args, headers) as ws:
        raw = await asyncio.wait_for(ws.recv(), timeout=args.timeout)
        if not (isinstance(raw, str) and "认证失败" in raw):
            raise AssertionError(f"expected auth refusal text, got: {type(raw).__name__}")
        try:
            await asyncio.wait_for(ws.recv(), timeout=args.timeout)
            raise AssertionError("connection stayed open after auth refusal")
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
    print("auth-negative OK (refusal text + close)")


async def probe_silent_binary(args):
    headers = {"Device-Id": args.device_id, "Client-Id": args.client_id}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"
    async with await connect(args, headers) as ws:
        # Junk binary must never be echoed back or answered with content, and
        # it must never crash the server (the server-side health re-check that
        # follows this probe proves "no crash"). The connection may either
        # stay open silently (entry drop) or be closed by the protocol stack
        # on malformed input — both are fail-closed outcomes.
        await ws.send(b"\x00" * 128)
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=args.timeout)
            raise AssertionError(
                f"binary junk was answered (expected no content): {str(raw)[:80]}"
            )
        except asyncio.TimeoutError:
            stayed_open = True
        except websockets.ConnectionClosed:
            stayed_open = False
        if stayed_open:
            # If the connection survived, the protocol face must still work.
            await ws.send(build_hello())
            ack = await recv_json(ws, args.timeout)
            if ack.get("type") != "hello" or not ack.get("session_id"):
                raise AssertionError("protocol face broken after binary junk")
    print("binary-negative OK (no content echo, no server crash)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True, help="ws:// or wss:// device endpoint")
    parser.add_argument("--device-id", default="aa:bb:cc:dd:ee:ff")
    parser.add_argument("--client-id", default="probe-client")
    parser.add_argument(
        "--auth-key",
        default=None,
        help="server auth_key (hex); default: env XIAOZHI_AUTH_KEY",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="use a pre-computed token instead of --auth-key",
    )
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--insecure", action="store_true", help="skip wss cert verify")
    parser.add_argument(
        "--without-abort", dest="with_abort", action="store_false", default=True
    )
    parser.add_argument("--expect-auth-failure", action="store_true")
    parser.add_argument("--expect-silent-binary", action="store_true")
    args = parser.parse_args()

    modes = [args.expect_auth_failure, args.expect_silent_binary]
    if sum(1 for m in modes if m) > 1:
        raise SystemExit("[xiaozhi:probe] negative modes are mutually exclusive")

    if args.expect_auth_failure:
        asyncio.run(probe_auth_failure(args))
        return 0
    if args.expect_silent_binary:
        secret = args.auth_key or os.environ.get("XIAOZHI_AUTH_KEY")
        if not args.token and not secret:
            raise SystemExit("[xiaozhi:probe] --expect-silent-binary needs auth")
        if secret and not args.token:
            args.token = generate_token(secret, args.client_id, args.device_id)
        asyncio.run(probe_silent_binary(args))
        return 0

    secret = args.auth_key or os.environ.get("XIAOZHI_AUTH_KEY")
    if not args.token and not secret:
        raise SystemExit("[xiaozhi:probe] missing --token/--auth-key/XIAOZHI_AUTH_KEY")
    if secret and not args.token:
        args.token = generate_token(secret, args.client_id, args.device_id)
    asyncio.run(probe_positive(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
