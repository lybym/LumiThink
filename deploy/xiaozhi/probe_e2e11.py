#!/usr/bin/env python3
"""E2E-11 (issue #61): wired-loop RELIABILITY REGRESSION probe
(real pinned server + real gateway/DSH processes, protocol-simulated device).

Extends the E2E-07 full loop (probe_e2e07.py) and the E2E-09 barge-in
measurement (probe_e2e09.py) with the fault-injection matrix the issue
requires at the DEVICE-TRANSPORT level, plus a per-round LATENCY
DECOMPOSITION (issue 实现范围 4):

   stt_echo_ms        detect → first `stt` echo        (ASR 到达面)
   first_sentence_ms  detect → first `sentence_start`  (LLM 首安全短句代理：
                       the sentence already crossed the Output Gate)
   first_audio_ms     detect → first binary Opus frame (TTS 首音代理)
   turn_total_ms      detect → `tts stop`              (播报完成)
   stop_response_ms   abort → `tts stop`               (停止响应, fault trials)

The wake-word face (唤醒) has no wire equivalent — it stays a physical
acceptance item (runbook §14.4).

fault trials (--faults, comma list):
   wifi_drop       mid-playback the connection is HARD-closed (cable pull
                   proxy; NO abort is sent) → reconnect (retry loop) → the
                   recovery turn must complete in full; audio that arrives
                   on the fresh connection BEFORE its own detect is RECORDED
                   (continuation semantics), never asserted;
   cancel_flood    one mid-playback abort followed by a rapid burst of
                   further aborts on the SAME connection (取消洪泛) → the
                   stop must arrive, ZERO late audio/sentence frames after
                   it → a no-playback idle burst (recorded) → recovery turn
                   must complete;
   server_restart  mid-playback the OPERATOR-SUPPLIED --restart-command is
                   executed (service-process restart injection; CI passes a
                   kill+relaunch snippet, an operator maps it to
                   `systemctl restart xiaozhi-server`) → the connection must
                   drop → reconnect retry → recovery turn must complete.

duplicate device sessions are NOT re-probed here: the E2E-07 gate already
proves lease refusal + first-connection-unaffected (probe_e2e07.py
--expect-duplicate-refusal); runbook §14.2 references it.

PRIVACY: sentence texts are counted, never printed; audio bytes are only
counted. Output is content-free.

MEASUREMENT DISCIPLINE (issue DoD): printed latencies are OBJECTIVE
SERVER-SIDE measurements collected as candidate baselines — never real-device
acceptance numbers, never a gate (frozen physical thresholds belong to the
physical protocol, runbook §14.4). The HARD assertions are the structural
invariants: every gated trial reaches its stop, zero late frames after it,
and a full recovery turn.
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
import subprocess
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


async def hard_close(ws):
    """Best-effort cable pull: an abrupt transport abort (RST), falling back
    to the library close when no transport handle is exposed."""
    transport = getattr(ws, "transport", None)
    if transport is not None:
        try:
            transport.abort()
            return
        except Exception:
            pass
    try:
        await ws.close()
    except Exception:
        pass


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
    """Content-free per-trial measurement record (latency decomposition)."""

    def __init__(self, kind, index):
        self.kind = kind
        self.index = index
        self.ok = False
        self.category = None
        self.stt_echo_ms = None          # detect → stt echo
        self.first_sentence_ms = None    # detect → first sentence_start
        self.first_audio_ms = None       # detect → first binary frame
        self.turn_total_ms = None        # detect → tts stop
        self.stop_response_ms = None     # abort → tts stop (fault trials)
        self.late_frames = 0             # audio/sentence_start AFTER a stop
        self.recovery_first_audio_ms = None
        self.continuation_audio_frames = None  # pre-detect audio on a fresh
                                               # connection (RECORDED only)

    def row(self):
        fields = [
            f"kind={self.kind}",
            f"idx={self.index}",
            f"ok={'true' if self.ok else 'false'}",
        ]
        if self.category is not None:
            fields.append(f"category={self.category}")
        for name in ("stt_echo_ms", "first_sentence_ms", "first_audio_ms", "turn_total_ms", "stop_response_ms"):
            value = getattr(self, name)
            if value is not None:
                fields.append(f"{name}={value:.1f}")
        fields.append(f"late_frames={self.late_frames}")
        if self.recovery_first_audio_ms is not None:
            fields.append(f"recovery_first_audio_ms={self.recovery_first_audio_ms:.1f}")
        if self.continuation_audio_frames is not None:
            fields.append(f"continuation_audio_frames={self.continuation_audio_frames}")
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


class LatencyBook:
    """Aggregates the per-round latency decomposition (counts only)."""

    def __init__(self):
        self.stt_echo = []
        self.first_sentence = []
        self.first_audio = []
        self.turn_total = []
        self.stop_response = []

    def add(self, result):
        for name, bucket in (
            ("stt_echo_ms", self.stt_echo),
            ("first_sentence_ms", self.first_sentence),
            ("first_audio_ms", self.first_audio),
            ("turn_total_ms", self.turn_total),
            ("stop_response_ms", self.stop_response),
        ):
            value = getattr(result, name)
            if value is not None:
                bucket.append(value)

    def summary(self):
        return (
            f"stt_echo_ms[{fmt_percentiles(self.stt_echo)}] "
            f"first_sentence_ms[{fmt_percentiles(self.first_sentence)}] "
            f"first_audio_ms[{fmt_percentiles(self.first_audio)}] "
            f"turn_total_ms[{fmt_percentiles(self.turn_total)}] "
            f"stop_response_ms[{fmt_percentiles(self.stop_response)}]"
        )


async def run_full_turn(ws, args, result, sent_at):
    """One conversation round: detect → stt echo → sentence → audio → stop.

    Records the latency decomposition on `result`; raises TrialFailure when
    the round does not complete structurally. After the stop, the late
    window is drained and counted (caller asserts zero).
    """
    counter = FrameCounter()
    saw_stop = False
    while not (saw_stop and counter.stt_echo >= 1):
        remaining = sent_at + args.turn_timeout - time.monotonic()
        if remaining <= 0:
            if counter.stt_echo < 1:
                raise TrialFailure("no_stt_echo", "the turn produced no stt echo")
            raise TrialFailure("turn_incomplete", "the turn never reached its stop")
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            if counter.stt_echo < 1:
                raise TrialFailure("no_stt_echo", "the turn produced no stt echo")
            raise TrialFailure("turn_incomplete", "the turn never reached its stop")
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed during the turn ({error})")
        if isinstance(raw, bytes):
            counter.audio_frames += 1
            if result.first_audio_ms is None:
                result.first_audio_ms = (time.monotonic() - sent_at) * 1000.0
            continue
        message = json.loads(raw)
        kind = message.get("type")
        state = message.get("state")
        if kind == "stt":
            counter.stt_echo += 1
            if result.stt_echo_ms is None:
                result.stt_echo_ms = (time.monotonic() - sent_at) * 1000.0
        elif kind == "tts" and state == "start":
            counter.tts_start += 1
        elif kind == "tts" and state == "sentence_start":
            counter.sentence_starts += 1
            if result.first_sentence_ms is None:
                result.first_sentence_ms = (time.monotonic() - sent_at) * 1000.0
        elif kind == "tts" and state == "stop":
            if counter.audio_frames < 1 or counter.sentence_starts < 1:
                raise TrialFailure(
                    "turn_incomplete",
                    f"the stop arrived without audio/sentences (audio={counter.audio_frames}, sentences={counter.sentence_starts})",
                )
            saw_stop = True
            result.turn_total_ms = (time.monotonic() - sent_at) * 1000.0
    # Late window after the stop: zero audio / sentence frames allowed.
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
        else:
            message = json.loads(raw)
            if message.get("type") == "tts" and message.get("state") == "sentence_start":
                late += 1
    result.late_frames += late
    if late > 0:
        raise TrialFailure("late_frames_after_stop", f"{late} audio/sentence frames after the stop")


async def wait_audio_then_inject(ws, args, frames):
    """detect → wait `frames` downlink audio frames → return the detect time."""
    sent = time.monotonic()
    await send_detect(ws, args.text)
    counter = FrameCounter()
    deadline = sent + args.turn_timeout
    while counter.audio_frames < frames:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TrialFailure(
                "no_playback_start", f"timed out waiting for {frames} downlink audio frame(s)"
            )
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            raise TrialFailure(
                "no_playback_start", f"timed out waiting for {frames} downlink audio frame(s)"
            )
        except websockets.ConnectionClosed as error:
            raise TrialFailure("connection_lost", f"closed while waiting for playback ({error})")
        if isinstance(raw, bytes):
            counter.audio_frames += 1
            continue
        message = json.loads(raw)
        if message.get("type") == "tts" and message.get("state") == "stop":
            raise TrialFailure("no_playback_start", "the turn stopped before playback (no fault surface)")
    return sent, counter


async def abort_and_wait_stop(ws, args, result):
    """abort → measure stop_response_ms → enforce the late window."""
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
            result.stop_response_ms = (time.monotonic() - sent) * 1000.0
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
    result.late_frames += late
    if late > 0:
        raise TrialFailure("late_frames_after_stop", f"{late} audio/sentence frames after the abort stop")


async def open_with_retry(args, device_id, client_tag, deadline_s):
    """Reconnect loop: hello must succeed within the deadline (the server
    may still be noticing the dead lease, rebooting, or refusing a
    momentarily duplicated device)."""
    deadline = time.monotonic() + deadline_s
    attempt = 0
    while True:
        attempt += 1
        if time.monotonic() > deadline:
            raise TrialFailure("reconnect_timeout", f"no successful hello within {deadline_s}s ({attempt} attempts)")
        token = generate_token(args.auth_key, f"{client_tag}-r{attempt:02d}", device_id)
        try:
            ws = await connect(args, device_id, f"{client_tag}-r{attempt:02d}", token)
            await hello_phase(ws, args.timeout)
            return ws
        except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as error:
            await asyncio.sleep(args.reconnect_interval)


async def drain_pre_detect(ws, args, result):
    """Record (never assert) audio arriving on a fresh connection BEFORE its
    own detect: post-restart semantics suspend playback (expected 0); after
    a plain Wi-Fi drop the current-epoch tail MAY legitimately continue."""
    stale = 0
    deadline = time.monotonic() + args.stale_window
    while time.monotonic() < deadline:
        try:
            raw = await recv_msg(ws, max(0.05, deadline - time.monotonic()))
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            break
        if isinstance(raw, bytes):
            stale += 1
        else:
            message = json.loads(raw)
            if message.get("type") == "tts" and message.get("state") == "sentence_start":
                stale += 1
    result.continuation_audio_frames = stale


async def run_recovery_turn(ws, args, result):
    """Post-fault recovery: a fresh detect must reach audio and stop again."""
    recovery_sent = time.monotonic()
    await send_detect(ws, args.recovery_text)
    counter = FrameCounter()
    saw_stop_after_audio = False
    while not (saw_stop_after_audio and counter.stt_echo >= 1):
        remaining = recovery_sent + args.turn_timeout - time.monotonic()
        if remaining <= 0:
            if counter.audio_frames < 1:
                raise TrialFailure(
                    "recovery_no_audio",
                    "the recovery turn produced no downlink audio",
                )
            raise TrialFailure("recovery_timeout", "the recovery turn never completed")
        try:
            raw = await recv_msg(ws, remaining)
        except asyncio.TimeoutError:
            if counter.audio_frames < 1:
                raise TrialFailure(
                    "recovery_no_audio",
                    "the recovery turn produced no downlink audio",
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
    # Late window after the recovery stop too.
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
    result.late_frames += late
    if late > 0:
        raise TrialFailure("late_frames_after_stop", f"{late} late frames after the recovery stop")


async def trial_wifi_drop(args, device_id, index):
    """Mid-playback hard close (cable pull proxy) → reconnect → recovery."""
    result = TrialResult(kind="wifi_drop", index=index)
    token = generate_token(args.auth_key, f"{args.client_id}-wd{index:02d}", device_id)
    async with await connect(args, device_id, f"{args.client_id}-wd{index:02d}", token) as ws:
        await hello_phase(ws, args.timeout)
        await wait_audio_then_inject(ws, args, args.drop_after_frames)
        # NO abort — the Wi-Fi death must look involuntary to the server.
        await hard_close(ws)
    ws = await open_with_retry(args, device_id, f"{args.client_id}-wd{index:02d}-re", args.reconnect_timeout)
    try:
        await drain_pre_detect(ws, args, result)
        await run_recovery_turn(ws, args, result)
    finally:
        try:
            await ws.close()
        except Exception:
            pass
    result.ok = True
    return result


async def trial_cancel_flood(args, device_id, index):
    """One mid-playback abort + a rapid burst of further aborts (取消洪泛)
    on ONE connection → stop → zero late frames → idle burst (recorded) →
    recovery turn."""
    result = TrialResult(kind="cancel_flood", index=index)
    token = generate_token(args.auth_key, f"{args.client_id}-cf{index:02d}", device_id)
    async with await connect(args, device_id, f"{args.client_id}-cf{index:02d}", token) as ws:
        await hello_phase(ws, args.timeout)
        await wait_audio_then_inject(ws, args, 1)
        # The flood: the first abort fences the playing turn; the burst
        # arrives while playback is already stopping / stopped.
        await send_abort(ws)
        for _ in range(args.flood_count - 1):
            await send_abort(ws)
        await abort_and_wait_stop(ws, args, result)
        # Idle burst with nothing playing: benign no-op semantics — whether
        # any stop is emitted is RECORDED, never asserted (E2E-09 discipline).
        for _ in range(args.flood_count):
            await send_abort(ws)
        await run_recovery_turn(ws, args, result)
    result.ok = True
    return result


async def trial_server_restart(args, device_id, index):
    """Operator-supplied restart command fires MID-PLAYBACK → the connection
    must drop → reconnect retry → recovery turn."""
    if not args.restart_command:
        raise SystemExit("[xiaozhi:probe-e2e11] server_restart requires --restart-command")
    result = TrialResult(kind="server_restart", index=index)
    token = generate_token(args.auth_key, f"{args.client_id}-sr{index:02d}", device_id)
    async with await connect(args, device_id, f"{args.client_id}-sr{index:02d}", token) as ws:
        await hello_phase(ws, args.timeout)
        await wait_audio_then_inject(ws, args, 1)
        try:
            proc = subprocess.run(
                args.restart_command,
                shell=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=args.restart_command_timeout,
            )
        except subprocess.TimeoutExpired:
            raise TrialFailure(
                "restart_command_timeout",
                f"the restart command exceeded {args.restart_command_timeout}s",
            )
        # The restart must actually take the connection down.
        drop_deadline = time.monotonic() + args.restart_deadline
        dropped = False
        while time.monotonic() < drop_deadline:
            try:
                raw = await recv_msg(ws, max(0.05, drop_deadline - time.monotonic()))
            except (asyncio.TimeoutError, websockets.ConnectionClosed, OSError):
                dropped = True
                break
            # Frames may still be in flight while the process dies; only a
            # stop would mean the turn finished before the restart landed.
            if not isinstance(raw, bytes) and (
                json.loads(raw).get("type") == "tts" and json.loads(raw).get("state") == "stop"
            ):
                raise TrialFailure(
                    "restart_no_disconnect",
                    "the turn completed before the restart took the connection down",
                )
        if not dropped:
            raise TrialFailure(
                "restart_no_disconnect",
                f"the connection survived {args.restart_deadline}s past the restart command (rc={proc.returncode})",
            )
    ws = await open_with_retry(args, device_id, f"{args.client_id}-sr{index:02d}-re", args.reconnect_timeout)
    try:
        await drain_pre_detect(ws, args, result)
        await run_recovery_turn(ws, args, result)
    finally:
        try:
            await ws.close()
        except Exception:
            pass
    result.ok = True
    return result


async def probe_reliability(args):
    variants = [entry.strip() for entry in args.faults.split(",") if entry.strip()]
    for entry in variants:
        if entry not in {"wifi_drop", "cancel_flood", "server_restart"}:
            raise SystemExit(f"[xiaozhi:probe-e2e11] unknown fault: {entry}")
    if "server_restart" in variants and not args.restart_command:
        raise SystemExit("[xiaozhi:probe-e2e11] server_restart requires --restart-command")

    book = LatencyBook()
    results = []

    # Long-haul rounds: fresh connection each (the lease-release +
    # session-resume path is exercised every round), full latency
    # decomposition per round.
    for round_index in range(1, args.rounds + 1):
        token = generate_token(args.auth_key, f"{args.client_id}-lh{round_index:02d}", args.device_id)
        async with await connect(args, args.device_id, f"{args.client_id}-lh{round_index:02d}", token) as ws:
            await hello_phase(ws, args.timeout)
            result = TrialResult(kind="longhaul", index=round_index)
            sent = time.monotonic()
            await send_detect(ws, args.text)
            await run_full_turn(ws, args, result, sent)
            results.append(result)
            book.add(result)
            print(f"reliability round {result.row()}")

    index = 0
    if "wifi_drop" in variants:
        for _ in range(args.wifi_drop_trials):
            index += 1
            result = await trial_wifi_drop(args, args.device_id, index)
            results.append(result)
            book.add(result)
            print(f"reliability trial {result.row()}")
    if "cancel_flood" in variants:
        for _ in range(args.cancel_flood_trials):
            index += 1
            result = await trial_cancel_flood(args, args.device_id, index)
            results.append(result)
            book.add(result)
            print(f"reliability trial {result.row()}")
    if "server_restart" in variants:
        for _ in range(args.server_restart_trials):
            index += 1
            result = await trial_server_restart(args, args.device_id, index)
            results.append(result)
            book.add(result)
            print(f"reliability trial {result.row()}")

    failed = [entry for entry in results if not entry.ok]
    late_total = sum(entry.late_frames for entry in results)
    continuation = [entry.continuation_audio_frames for entry in results if entry.continuation_audio_frames is not None]
    print(
        "reliability summary: "
        f"rounds={args.rounds} trials={len(results) - args.rounds} "
        f"ok={sum(1 for entry in results if entry.ok)} failed={len(failed)} "
        f"late_frames_total={late_total} "
        f"continuation_pre_detect_frames={continuation if continuation else 'n/a'} "
        + book.summary()
    )
    print(
        "latency decomposition note: wake-word → ASR has no wire equivalent; "
        "it stays a physical acceptance item (runbook §14.4). Candidate "
        "baselines only — never real-device acceptance numbers."
    )
    if failed:
        categories = {}
        for entry in failed:
            key = entry.category or "unknown"
            categories[key] = categories.get(key, 0) + 1
        raise AssertionError(
            f"{len(failed)} reliability trial(s) failed: "
            + ", ".join(f"{key}={value}" for key, value in sorted(categories.items()))
        )
    if late_total > 0:
        raise AssertionError(f"{late_total} late frames after stops (stale epoch leak)")
    print("reliability regression OK (all rounds/trials passed, zero late frames)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--device-id", default="aa:bb:cc:dd:ee:08")
    parser.add_argument("--client-id", default="e2e11-probe")
    parser.add_argument("--auth-key", default=None, help="default: env XIAOZHI_AUTH_KEY")
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--turn-timeout", type=float, default=90.0)
    parser.add_argument("--late-window", type=float, default=1.5)
    parser.add_argument(
        "--rounds", type=int, default=3,
        help="long-haul conversation rounds with per-round latency decomposition",
    )
    parser.add_argument(
        "--faults", default="",
        help="comma list: wifi_drop,cancel_flood,server_restart (empty string = long-haul only)",
    )
    parser.add_argument("--wifi-drop-trials", type=int, default=1)
    parser.add_argument("--cancel-flood-trials", type=int, default=1)
    parser.add_argument("--server-restart-trials", type=int, default=1)
    parser.add_argument(
        "--flood-count", type=int, default=10,
        help="aborts per cancel-flood burst (first mid-playback, rest rapid-fire)",
    )
    parser.add_argument(
        "--drop-after-frames", type=int, default=3,
        help="audio frames received before the Wi-Fi drop is injected",
    )
    parser.add_argument(
        "--restart-command", default=None,
        help="operator-supplied shell command executed ONCE mid-playback (service restart injection)",
    )
    parser.add_argument(
        "--restart-command-timeout", type=float, default=30.0,
        help="wall-clock cap for the restart command itself",
    )
    parser.add_argument(
        "--restart-deadline", type=float, default=15.0,
        help="how long the connection may take to drop after the restart command",
    )
    parser.add_argument(
        "--reconnect-timeout", type=float, default=60.0,
        help="reconnect+hello retry budget after a fault",
    )
    parser.add_argument("--reconnect-interval", type=float, default=1.0)
    parser.add_argument(
        "--stale-window", type=float, default=2.0,
        help="how long a fresh connection is observed BEFORE its own detect "
             "(continuation audio is RECORDED, never asserted)",
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
        help="the post-fault recovery utterance (synthetic child-safe sample)",
    )
    parser.add_argument("--expect-reliability-regression", action="store_true", default=True)
    args = parser.parse_args()

    secret = args.auth_key or os.environ.get("XIAOZHI_AUTH_KEY")
    if not secret:
        raise SystemExit("[xiaozhi:probe-e2e11] missing --auth-key/XIAOZHI_AUTH_KEY")
    args.auth_key = secret

    asyncio.run(probe_reliability(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
