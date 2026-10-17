#!/usr/bin/env python3
"""E2E-09 (issue #59): barge-in MEASUREMENT probe for the WIRED
xiaozhi↔LumiThink loop (real pinned server + real gateway/DSH processes).

Extends the E2E-07 single-shot abort fence (probe_e2e07.py
--expect-abort-fence) into a multi-trial measurement instrument:

  per trial: hello → listen detect (the simulated utterance) → wait for the
  downlink audio to flow → send the wire `abort` (the issue's client_abort)
  → MEASURE abort→tts-stop latency → assert ZERO late audio/sentence frames
  after the stop → recovery: a fresh listen detect on the SAME connection
  must reach stt echo + REAL binary Opus frames + tts stop again (the
  server-side half of the upstream "no audio after interruption" report,
  xinnan-tech issue #743; the device-side half stays a physical acceptance
  item, deploy/xiaozhi/runbook.md §12).

  trial kinds:
    standard     barge-in right after the first audio frame (fresh
                 connection per trial — the lease-release + session-resume
                 path is exercised every trial, same as the E2E-08 loop);
    consecutive  two barge-ins back-to-back on ONE connection (连续抢话),
                 then the final recovery turn;
    delayed      the abort is held back until several audio frames have
                 passed (network-jitter proxy: the interrupt arrives late);
    idle         an abort with NOTHING playing (false-interrupt protocol
                 proxy, 无说话只有播放误打断): the protocol face must survive
                 and the next turn must still complete; whether a stop was
                 emitted is RECORDED, never asserted.

PRIVACY: sentence texts are counted, never printed; audio bytes are only
counted. Output is content-free.

MEASUREMENT DISCIPLINE (issue DoD): the printed latencies are OBJECTIVE
SERVER-SIDE MEASUREMENTS collected as candidate baselines — they are never
treated as real-device acceptance numbers and never gate this probe (the
frozen product thresholds belong to the physical protocol, runbook §12.3).
The HARD assertions here are the structural invariants: every gated trial
gets its stop, zero late frames after it, and a full recovery turn.
"""

import argparse
import asyncio
import base64
import hashlib
import hmac
import json
import math
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


async def send_detect(ws, text):
    await ws.send(json.dumps({"type": "listen", "state": "detect", "mode": "manual", "text": text}))


async def send_abort(ws):
    # Wire `abort` == the issue's client_abort (VOICE_GATEWAY_PROTOCOL §1).
    await ws.send(json.dumps({"type": "abort"}))


class TrialFailure(Exception):
    """A structural trial failure (category + detail)."""

    def __init__(self, category, detail=""):
        super().__init__(f"{category}: {detail}" if detail else category)
        self.category = category


class FrameCounter:
    """Content-free per-connection frame accounting (counts only)."""

    def __init__(self):
        self.audio_frames = 0
        self.stt_echo = 0
        self.tts_start = 0
        self.sentence_starts = 0


class TrialResult:
    """Content-free per-trial measurement record."""

    def __init__(self, kind, index):
        self.kind = kind
        self.index = index
        self.ok = False
        self.category = None
        self.abort_to_stop_ms = None          # abort sent → tts stop received
        self.late_frames = 0                  # audio/sentence_start AFTER the stop
        self.recovery_first_audio_ms = None   # recovery detect → its first audio
        self.idle_stop_observed = None        # idle kind only: stop emitted?

    def row(self):
        fields = [
            f"kind={self.kind}",
            f"idx={self.index}",
            f"ok={'true' if self.ok else 'false'}",
        ]
        if self.category is not None:
            fields.append(f"category={self.category}")
        if self.abort_to_stop_ms is not None:
            fields.append(f"abort_to_stop_ms={self.abort_to_stop_ms:.1f}")
        fields.append(f"late_frames={self.late_frames}")
        if self.recovery_first_audio_ms is not None:
            fields.append(f"recovery_first_audio_ms={self.recovery_first_audio_ms:.1f}")
        if self.idle_stop_observed is not None:
            fields.append(f"idle_stop_observed={'true' if self.idle_stop_observed else 'false'}")
        return " ".join(fields)


def percentile(values, fraction):
    """Nearest-rank percentile over an unsorted list (None when empty)."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, min(len(ordered), math.ceil(fraction * len(ordered))))
    return ordered[rank - 1]


def fmt_percentiles(values):
    if not values:
        return "n/a"
    p50 = percentile(values, 0.50)
    p95 = percentile(values, 0.95)
    p99 = percentile(values, 0.99)
    return f"p50={p50:.1f},p95={p95:.1f},p99={p99:.1f},max={max(values):.1f}"


async def recv_until_audio(ws, args, counter, target_frames=1, what="playback start"):
    """Read frames until `target_frames` audio bytes crossed (or fail)."""
    deadline = time.monotonic() + args.turn_timeout
    while counter.audio_frames < target_frames:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TrialFailure(
                "no_playback_start",
                f"timed out waiting for {target_frames} downlink audio frame(s) ({what})",
            )
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            raise TrialFailure(
                "no_playback_start",
                f"timed out waiting for {target_frames} downlink audio frame(s) ({what})",
            )
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed while waiting for {what} ({error})")
        if isinstance(raw, bytes):
            counter.audio_frames += 1
            continue
        message = json.loads(raw)
        kind = message.get("type")
        state = message.get("state")
        if kind == "stt":
            counter.stt_echo += 1
        elif kind == "tts" and state == "start":
            counter.tts_start += 1
        elif kind == "tts" and state == "sentence_start":
            counter.sentence_starts += 1
        elif kind == "tts" and state == "stop":
            raise TrialFailure(
                "no_playback_start",
                "the turn stopped before its first audio frame (no barge-in surface)",
            )


async def abort_and_wait_stop(ws, args, result):
    """Send the barge-in abort; measure abort→stop; enforce the late window.

    The trial fails when the stop never arrives (no_stop_after_abort) or
    audio/sentence frames follow the stop (late_frames_after_stop — the
    stale-epoch leak shape at the server edge). Audio crossing BEFORE the
    stop is in-flight playback racing the sender cancellation; only frames
    after the stop count as late.
    """
    sent = time.monotonic()
    await send_abort(ws)
    saw_stop = False
    while not saw_stop:
        remaining = sent + args.turn_timeout - time.monotonic()
        if remaining <= 0:
            raise TrialFailure("no_stop_after_abort", f"no tts stop within {args.turn_timeout}s of the abort")
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            raise TrialFailure("no_stop_after_abort", f"no tts stop within {args.turn_timeout}s of the abort")
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed while waiting for the abort stop ({error})")
        if isinstance(raw, bytes):
            continue  # in-flight playback before the stop: not a leak
        message = json.loads(raw)
        if message.get("type") == "tts" and message.get("state") == "stop":
            saw_stop = True
            result.abort_to_stop_ms = (time.monotonic() - sent) * 1000.0
    stop_at = time.monotonic()
    late = 0
    while True:
        remaining = stop_at + args.late_window - time.monotonic()
        if remaining <= 0:
            break
        try:
            raw = await recv_msg(ws, remaining)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            break
        if isinstance(raw, bytes):
            late += 1
        elif (
            json.loads(raw).get("type") == "tts"
            and json.loads(raw).get("state") == "sentence_start"
        ):
            late += 1
    result.late_frames = late
    if late > 0:
        raise TrialFailure("late_frames_after_stop", f"{late} audio/sentence frames after the abort stop")


async def run_recovery_turn(ws, args, result):
    """Post-interruption recovery: a fresh detect must reach audio again.

    Server-side half of the upstream issue-#743 scenario (an interrupted
    playback must not silence the following turns); the device-side half is
    the physical acceptance item (runbook §12.4).
    """
    recovery_sent = time.monotonic()
    await send_detect(ws, args.recovery_text)
    counter = FrameCounter()
    saw_stop_after_audio = False
    while not (saw_stop_after_audio and counter.audio_frames >= 1 and counter.stt_echo >= 1):
        remaining = recovery_sent + args.turn_timeout - time.monotonic()
        if remaining <= 0:
            if counter.audio_frames < 1:
                raise TrialFailure(
                    "recovery_no_audio",
                    "the recovery turn produced no downlink audio (server-side #743 shape)",
                )
            raise TrialFailure("recovery_timeout", "the recovery turn never completed")
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            if counter.audio_frames < 1:
                raise TrialFailure(
                    "recovery_no_audio",
                    "the recovery turn produced no downlink audio (server-side #743 shape)",
                )
            raise TrialFailure("recovery_timeout", "the recovery turn never completed")
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed during the recovery turn ({error})")
        if isinstance(raw, bytes):
            counter.audio_frames += 1
            if result.recovery_first_audio_ms is None:
                result.recovery_first_audio_ms = (time.monotonic() - recovery_sent) * 1000.0
            continue
        message = json.loads(raw)
        kind = message.get("type")
        state = message.get("state")
        if kind == "stt":
            counter.stt_echo += 1
        elif kind == "tts" and state == "sentence_start":
            counter.sentence_starts += 1
        elif kind == "tts" and state == "stop" and counter.audio_frames >= 1:
            saw_stop_after_audio = True


async def run_gated_trial(ws, args, kind, index):
    """One barge-in trial of the requested kind on an open connection."""
    result = TrialResult(kind=kind, index=index)
    counter = FrameCounter()
    await send_detect(ws, args.text)
    if kind == "delayed":
        # Hold the interrupt back until several audio frames passed (the
        # network-jitter proxy): the barge-in arrives mid-playback, late.
        await recv_until_audio(ws, args, counter, target_frames=args.delay_after_frames, what="delayed abort")
    else:
        await recv_until_audio(ws, args, counter, target_frames=1, what="playback start")
    await abort_and_wait_stop(ws, args, result)
    await run_recovery_turn(ws, args, result)
    result.ok = True
    return result


async def run_consecutive_trial(ws, args):
    """连续抢话: two barge-ins back-to-back on ONE connection, then recovery."""
    first = TrialResult(kind="consecutive", index=1)
    counter = FrameCounter()
    await send_detect(ws, args.text)
    await recv_until_audio(ws, args, counter, target_frames=1, what="consecutive cycle 1")
    await abort_and_wait_stop(ws, args, first)
    second = TrialResult(kind="consecutive", index=2)
    counter = FrameCounter()
    await send_detect(ws, args.text)
    await recv_until_audio(ws, args, counter, target_frames=1, what="consecutive cycle 2")
    await abort_and_wait_stop(ws, args, second)
    await run_recovery_turn(ws, args, second)
    first.ok = True
    second.ok = True
    return first, second


async def run_idle_trial(ws, args, index):
    """Abort with NOTHING playing (false-interrupt protocol proxy).

    The invariant is survival: the protocol face must not break and the
    next turn must still complete. Whether the pinned server emits a stop
    for a playback-less abort is RECORDED (never asserted, never gated).
    """
    result = TrialResult(kind="idle", index=index)
    await send_abort(ws)
    stop_seen = False
    idle_deadline = time.monotonic() + args.timeout
    while not stop_seen and time.monotonic() < idle_deadline:
        try:
            raw = await recv_msg(ws, max(0.05, idle_deadline - time.monotonic()))
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            break
        if (
            isinstance(raw, str)
            and json.loads(raw).get("type") == "tts"
            and json.loads(raw).get("state") == "stop"
        ):
            stop_seen = True
    result.idle_stop_observed = stop_seen
    # The protocol face must survive: the next turn completes in full.
    counter = FrameCounter()
    completion_deadline = time.monotonic() + args.turn_timeout
    await send_detect(ws, args.text)
    await recv_until_audio(ws, args, counter, target_frames=1, what="post-idle-abort turn")
    while True:
        remaining = completion_deadline - time.monotonic()
        if remaining <= 0:
            raise TrialFailure("recovery_timeout", "the post-idle-abort turn never completed")
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            raise TrialFailure("recovery_timeout", "the post-idle-abort turn never completed")
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed after the idle abort ({error})")
        if isinstance(raw, bytes):
            counter.audio_frames += 1
            continue
        message = json.loads(raw)
        if message.get("type") == "tts" and message.get("state") == "stop":
            if counter.audio_frames < 1:
                raise TrialFailure(
                    "recovery_no_audio", "the post-idle-abort turn produced no downlink audio"
                )
            break
    result.ok = True
    return result


async def probe_barge_in_measurement(args):
    variants = [entry.strip() for entry in args.variants.split(",") if entry.strip()]
    for entry in variants:
        if entry not in {"consecutive", "delayed", "idle"}:
            raise SystemExit(f"[xiaozhi:probe-e2e09] unknown variant: {entry}")
    results = []
    # Standard trials: fresh connection each (the lease-release +
    # session-resume path is exercised every trial, same as the E2E-08
    # ten-round loop).
    for round_index in range(1, args.trials + 1):
        token = generate_token(args.auth_key, f"{args.client_id}-s{round_index:02d}", args.device_id)
        async with await connect(args, args.device_id, f"{args.client_id}-s{round_index:02d}", token) as ws:
            await hello_phase(ws, args.timeout)
            result = await run_gated_trial(ws, args, "standard", round_index)
            results.append(result)
            print(f"barge-in trial {result.row()}")
    if "consecutive" in variants:
        token = generate_token(args.auth_key, f"{args.client_id}-cons", args.device_id)
        async with await connect(args, args.device_id, f"{args.client_id}-cons", token) as ws:
            await hello_phase(ws, args.timeout)
            first, second = await run_consecutive_trial(ws, args)
            results.extend([first, second])
            print(f"barge-in trial {first.row()}")
            print(f"barge-in trial {second.row()}")
    if "delayed" in variants:
        token = generate_token(args.auth_key, f"{args.client_id}-delayed", args.device_id)
        async with await connect(args, args.device_id, f"{args.client_id}-delayed", token) as ws:
            await hello_phase(ws, args.timeout)
            result = await run_gated_trial(ws, args, "delayed", 0)
            results.append(result)
            print(f"barge-in trial {result.row()}")
    if "idle" in variants:
        token = generate_token(args.auth_key, f"{args.client_id}-idle", args.device_id)
        async with await connect(args, args.device_id, f"{args.client_id}-idle", token) as ws:
            await hello_phase(ws, args.timeout)
            result = await run_idle_trial(ws, args, 0)
            results.append(result)
            print(f"barge-in trial {result.row()}")

    gated = [entry for entry in results if entry.kind in {"standard", "consecutive", "delayed"}]
    failed = [entry for entry in results if not entry.ok]
    stops = [entry.abort_to_stop_ms for entry in gated if entry.abort_to_stop_ms is not None]
    recoveries = [entry.recovery_first_audio_ms for entry in results if entry.recovery_first_audio_ms is not None]
    late_total = sum(entry.late_frames for entry in results)
    idle_records = [entry for entry in results if entry.kind == "idle"]
    idle_stop = "n/a"
    if idle_records:
        idle_stop = "true" if idle_records[0].idle_stop_observed else "false"
    print(
        "barge-in summary: "
        f"trials={len(results)} gated={len(gated)} ok={sum(1 for entry in results if entry.ok)} "
        f"failed={len(failed)} late_frames_total={late_total} "
        f"stop_ms[{fmt_percentiles(stops)}] "
        f"recovery_first_audio_ms[{fmt_percentiles(recoveries)}] "
        f"idle_abort_stop={idle_stop}"
    )
    if failed:
        categories = {}
        for entry in failed:
            key = entry.category or "unknown"
            categories[key] = categories.get(key, 0) + 1
        raise AssertionError(
            f"{len(failed)} barge-in trial(s) failed: "
            + ", ".join(f"{key}={value}" for key, value in sorted(categories.items()))
        )
    if late_total > 0:
        raise AssertionError(f"{late_total} late frames after abort stops (stale epoch leak)")
    print("barge-in measurement OK (all trials passed, zero late frames)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--device-id", default="aa:bb:cc:dd:ee:08")
    parser.add_argument("--client-id", default="e2e09-probe")
    parser.add_argument("--auth-key", default=None, help="default: env XIAOZHI_AUTH_KEY")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--turn-timeout", type=float, default=45.0)
    parser.add_argument("--late-window", type=float, default=1.5)
    parser.add_argument(
        "--trials", type=int, default=4, help="standard barge-in trials (fresh connection each)"
    )
    parser.add_argument(
        "--variants",
        default="consecutive,delayed,idle",
        help="comma list of extra trials: consecutive,delayed,idle (empty string disables all)",
    )
    parser.add_argument(
        "--delay-after-frames",
        type=int,
        default=5,
        help="audio frames received before the delayed variant sends its abort",
    )
    parser.add_argument("--insecure", action="store_true")
    parser.add_argument(
        "--text",
        default="我们来玩个游戏好不好",
        help="simulated utterance (a clearly synthetic child-safe sample)",
    )
    parser.add_argument(
        "--recovery-text",
        default="那我们读书吧",
        help="the post-interruption recovery utterance (synthetic child-safe sample)",
    )
    parser.add_argument("--expect-barge-in-measurement", action="store_true", default=True)
    args = parser.parse_args()

    secret = args.auth_key or os.environ.get("XIAOZHI_AUTH_KEY")
    if not secret:
        raise SystemExit("[xiaozhi:probe-e2e09] missing --auth-key/XIAOZHI_AUTH_KEY")
    args.auth_key = secret

    asyncio.run(probe_barge_in_measurement(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
