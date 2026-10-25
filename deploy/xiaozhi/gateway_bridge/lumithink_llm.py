# E2E-07 (issue #57) — LumiThink Voice Gateway bridge LLM module.
#
# Installed by deploy/xiaozhi/gateway_bridge/install_bridge.py into the
# PINNED xiaozhi-esp32-server checkout as
#   core/providers/llm/lumithink/lumithink.py
# (the pinned commit's LLM extension point: core/utils/llm.py loads
# `core.providers.llm.<type>.<type>` and instantiates class `LLMProvider`;
# selected via config selected_module.LLM -> LLM.<name>.type = lumithink).
#
# WIRING (docs/VOICE_GATEWAY_PROTOCOL.md; ADR-0011):
#   device (v2.5.2 WS) → pinned server (auth/VAD/ASR/TTS/Opus) → THIS
#   module (the ONLY selected LLM — the built-in AI second path is
#   structurally unreachable) → PROTECTED internal transport (UDS/named
#   pipe + token; NO TCP) → LumiThink Voice Gateway Adapter stack →
#   Orchestrator → REAL Bridge IPC → DSH runtime
#     ← fence-stamped TTS sentences (Output-Gate-approved text) ←
#   this module (tts_text_queue) → pinned server TTS engine → Opus → device.
#
# FRAME ORDERING GUARANTEE: every gateway-bound frame (device_hello,
# session_issued, abort, turn_prompt, audio_delivered) is submitted to ONE
# control-worker FIFO. The server's abort flow (handleAbortMessage hook)
# strictly precedes the next chat submission on the loop thread, so its
# abort frame is queued BEFORE the next turn's turn_prompt — the gateway
# can therefore never fence the NEW turn with the OLD abort.
#
# FAIL-CLOSED RULES:
#   - No device mapping (hello never registered this session) → raise, no
#     model call, no built-in fallback (the built-in path IS this module).
#   - Gateway rejects the prompt (input gate / unbound / forged session) →
#     the generator raises so the server's own error path runs.
#   - Gateway unreachable / submit failure / turn timeout → raise (never
#     fall back to any other LLM).
#   - The fork-patch hooks never raise and never block the server's event
#     loop (control worker + guarded call sites, install_bridge.py).
#
# PRIVACY: the transcript and the sentence text exist only inside the
# transient frame path and the server's TTS queue. Nothing here is logged
# at content level, persisted, or written to disk. Audio bytes are only
# digested (sha256) for the content-free delivery accounting.

import hashlib
import json
import os
import queue
import socket
import struct
import threading
import time

from config.logger import setup_logging

# Native ConnectionHandler.chat owns TTS queue messages.

TAG = __name__
logger = setup_logging()

_MAX_FRAME_BYTES = 65536
_MAX_PROMPT_CHARS = 512
_PROTOCOL_VERSION = 1


class BridgeTransportError(RuntimeError):
    """The protected transport is down or the gateway rejected the turn."""


class _ConnState:
    """Per-device-connection state (registered by the hello fork hook)."""

    def __init__(self, conn, conn_id):
        self.conn = conn
        self.conn_id = conn_id
        self.current_turn = None
        self.sentence_started = False
        self.audio_frames = 0
        self.audio_digest = hashlib.sha256()
        self.closed = False


class _PipeSocket:
    """Minimal socket-like adapter over a Windows named pipe handle."""

    def __init__(self, handle):
        self._handle = handle

    def sendall(self, data):
        self._handle.write(data)

    def recv(self, _n):
        return self._handle.read(4096)

    def settimeout(self, _t):
        return None

    def close(self):
        try:
            self._handle.close()
        except OSError:
            pass


class _BridgeClient:
    """One authenticated connection to the LumiThink gateway over the
    protected local transport. A dedicated reader thread demultiplexes
    gateway frames BY connId (one in-flight turn per device connection —
    the server aborts the previous chat before starting the next). ALL
    outbound frames flow through the control worker; this class only
    performs thread-safe writes."""

    def __init__(self, endpoint, token):
        self._endpoint = endpoint
        self._token = token
        self._sock = None
        self._send_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._authenticated = False
        self._waiters = {}  # connId -> queue.Queue
        self._demux_lock = threading.Lock()

    # ---- lifecycle -------------------------------------------------------

    def ensure_connected(self, timeout_s=5.0):
        with self._state_lock:
            if self._sock is not None and self._authenticated:
                return
        sock = self._connect_endpoint()
        sock.settimeout(timeout_s)
        self._send_on(sock, {"kind": "bridge_auth", "v": _PROTOCOL_VERSION, "token": self._token})
        ready = self._recv_frame_on(sock, timeout_s=timeout_s)
        if not isinstance(ready, dict) or ready.get("kind") != "bridge_ready":
            try:
                sock.close()
            except OSError:
                pass
            raise BridgeTransportError("gateway did not answer bridge_ready")
        with self._state_lock:
            self._sock = sock
            self._authenticated = True
        reader = threading.Thread(target=self._read_loop, daemon=True, name="lumi-bridge-reader")
        reader.start()

    def _connect_endpoint(self):
        if self._endpoint.startswith("\\\\.\\pipe\\"):
            return _PipeSocket(open(self._endpoint, "r+b", buffering=0))
        if not hasattr(socket, "AF_UNIX"):
            raise BridgeTransportError("AF_UNIX unavailable; the protected transport has no TCP option")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.connect(self._endpoint)
        except OSError as exc:
            raise BridgeTransportError(f"gateway endpoint unreachable: {exc.__class__.__name__}") from exc
        return sock

    def close(self):
        with self._state_lock:
            self._authenticated = False
            sock = self._sock
            self._sock = None
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    # ---- framing ---------------------------------------------------------

    @staticmethod
    def _send_on(sock, frame):
        body = json.dumps(frame, ensure_ascii=False).encode("utf-8")
        if len(body) > _MAX_FRAME_BYTES:
            raise BridgeTransportError("frame exceeds the byte cap")
        sock.sendall(struct.pack(">I", len(body)) + body)

    @staticmethod
    def _recv_exact(sock, n, timeout_s):
        buf = b""
        deadline = time.time() + timeout_s
        while len(buf) < n:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise BridgeTransportError("gateway frame read timed out")
            sock.settimeout(remaining)
            chunk = sock.recv(n - len(buf))
            if not chunk:
                raise BridgeTransportError("gateway closed the connection")
            buf += chunk
        return buf

    @classmethod
    def _recv_frame_on(cls, sock, timeout_s=30.0):
        (length,) = struct.unpack(">I", cls._recv_exact(sock, 4, timeout_s))
        if length > _MAX_FRAME_BYTES:
            raise BridgeTransportError("oversize frame from gateway")
        return json.loads(cls._recv_exact(sock, length, timeout_s).decode("utf-8"))

    def send(self, frame):
        with self._state_lock:
            sock = self._sock
        if sock is None:
            raise BridgeTransportError("bridge transport is not connected")
        with self._send_lock:
            self._send_on(sock, frame)

    # ---- demultiplexing --------------------------------------------------

    def register_waiter(self, conn_id, waiter):
        with self._demux_lock:
            self._waiters[conn_id] = waiter

    def unregister_waiter(self, conn_id):
        with self._demux_lock:
            self._waiters.pop(conn_id, None)

    def _fail_all_waiters(self):
        with self._demux_lock:
            waiters = list(self._waiters.values())
            self._waiters.clear()
        for waiter in waiters:
            waiter.put({"kind": "transport_lost"})

    def _read_loop(self):
        while True:
            with self._state_lock:
                sock = self._sock
                authenticated = self._authenticated
            if sock is None or not authenticated:
                return
            try:
                frame = self._recv_frame_on(sock, timeout_s=3600.0)
            except (BridgeTransportError, OSError, json.JSONDecodeError, struct.error) as exc:
                logger.bind(tag=TAG).warning(f"[lumi-bridge] gateway reader stopped: {exc.__class__.__name__}: {exc} (in-flight turns fail closed; the next turn reconnects)")
                self.close()
                self._fail_all_waiters()
                return
            if not isinstance(frame, dict):
                continue
            with self._demux_lock:
                waiter = self._waiters.get(frame.get("connId"))
            kind = frame.get("kind")
            if kind == "queue_clear":
                self._provider_handle_queue_clear(frame)
                continue
            if kind == "device_drop":
                self._provider_handle_device_drop(frame)
                continue
            if kind in ("tts_sentence", "tts_end", "prompt_rejected", "turn_started"):
                if waiter is not None:
                    waiter.put(frame)
                continue
            if kind == "device_hello_result":
                if not frame.get("ok"):
                    # Content-free enumerated rejection (device_unbound /
                    # device_possession_denied / lease conflict) — visible
                    # in the server log instead of a silent dead mapping.
                    logger.bind(tag=TAG).warning(f"[lumi-bridge] device hello rejected by the gateway: {frame.get('code')}")
                continue
            # Unknown kinds are ignored: the gateway parses fail-closed on
            # ITS side; the bridge never acts on unregistered frames.

    def attach_provider(self, provider):
        self._provider = provider

    def _provider_handle_queue_clear(self, frame):
        state = self._provider.find_state_by_conn(frame.get("connId"))
        if state is None:
            return
        try:
            state.conn.clear_queues()
        except Exception:
            pass

    def _provider_handle_device_drop(self, frame):
        state = self._provider.find_state_by_conn(frame.get("connId"))
        if state is None:
            return
        state.closed = True
        self._provider.schedule_close(state.conn)


class _ControlWorker:
    """Single FIFO for every gateway-bound frame. Fork hooks run inside the
    server's asyncio handlers and the LLM generator runs in an executor
    thread — the shared queue gives BOTH a deterministic order (an abort
    hook queued on the loop strictly precedes the next turn's prompt) and
    keeps blocking connect/send work off the event loop."""

    def __init__(self):
        self._queue = queue.Queue(maxsize=4096)
        self._worker = threading.Thread(target=self._loop, daemon=True, name="lumi-bridge-control")
        self._worker.start()

    def submit(self, fn) -> None:
        """Fire-and-forget (hooks): never blocks the caller, never raises."""
        try:
            self._queue.put_nowait(fn)
        except queue.Full:
            pass  # drop the control work; hooks must never block hello

    def submit_wait(self, fn, timeout_s=8.0) -> None:
        """Bounded submit for the turn path: raises on failure/timeout so
        the generator fails fast instead of waiting for a dead gateway."""
        done = threading.Event()
        outcome = {}

        def _run():
            try:
                fn()
                outcome["ok"] = True
            except Exception as exc:  # BridgeTransportError/OSError
                outcome["error"] = exc
            finally:
                done.set()

        self.submit(_run)
        if not done.wait(timeout_s):
            raise BridgeTransportError("control submit timed out")
        if not outcome.get("ok"):
            raise BridgeTransportError(f"control submit failed: {outcome.get('error', 'unknown')}")

    def _loop(self):
        while True:
            fn = self._queue.get()
            if fn is None:
                return
            try:
                fn()
            except Exception:
                pass


class LLMProvider:
    r"""The LumiThink bridge at the pinned server's LLM extension point.

    Config (render-time injected, never literal):
      gateway_socket: UDS path (or `\\.\pipe\name` on Windows dev);
      auth_token_env: env var carrying the internal transport token;
      turn_timeout_s: bounded wait for the gateway turn (default 60).
    """

    supports_cancel_check = True

    def __init__(self, config):
        endpoint = config.get("gateway_socket")
        if not endpoint or not isinstance(endpoint, str):
            raise ValueError("lumithink LLM: gateway_socket is required in the provider config")
        token_env = config.get("auth_token_env", "LUMITHINK_GATEWAY_BRIDGE_TOKEN")
        token = os.environ.get(token_env, "")
        if not token:
            raise ValueError(f"lumithink LLM: env {token_env} must carry the internal transport token")
        self._endpoint = endpoint
        self._turn_timeout_s = float(config.get("turn_timeout_s", 60))
        self._client = _BridgeClient(endpoint, token)
        self._client.attach_provider(self)
        self._control = _ControlWorker()
        self._conns = {}  # session_id -> _ConnState
        self._conns_lock = threading.Lock()
        logger.bind(tag=TAG).info("lumithink bridge LLM initialized (protected internal transport, no TCP option)")

    # ------------------------------------------------------------------
    # Upstream LLM provider interface (core/providers/llm/base.py)
    # ------------------------------------------------------------------

    def response(self, session_id, dialogue, cancel_check=None):
        """Stream LumiThink's fence-stamped response sentences.

        `dialogue` carries the upstream conversation history; ONLY the last
        user message (the device's ASR final) crosses to LumiThink — the
        conversation state, persona and memory live behind the trusted
        Orchestrator, never in this module.
        """
        prompt = self._extract_last_user_text(dialogue)
        if not prompt or len(prompt) > _MAX_PROMPT_CHARS:
            logger.bind(tag=TAG).warning("[lumi-bridge] turn rejected locally: prompt is empty or exceeds the transient cap")
            raise BridgeTransportError("prompt is empty or exceeds the transient cap")
        state = self._conns.get(session_id)
        if state is None or state.closed:
            # Fail closed: a prompt without a registered (hello-authorized)
            # device mapping can never be authorized.
            logger.bind(tag=TAG).warning(f"[lumi-bridge] turn rejected locally: no registered mapping for the session (registered={len(self._conns)})")
            raise BridgeTransportError("no gateway-registered device mapping for this session")
        logger.bind(tag=TAG).warning("[lumi-bridge] turn_prompt submitting (content-free accounting follows)")

        waiter = queue.Queue()
        self._client.register_waiter(state.conn_id, waiter)
        prompt_frame = {
            "kind": "turn_prompt",
            "connId": state.conn_id,
            "xiaozhiSessionId": session_id,
            "text": prompt,
        }
        try:
            # FIFO submit (bounded): if the transport cannot carry even the
            # submit, the turn fails fast — never a silent fallback.
            self._control.submit_wait(lambda: self._client.ensure_connected(), timeout_s=8.0)
            self._control.submit_wait(lambda: self._client.send(prompt_frame), timeout_s=8.0)
        except BridgeTransportError:
            self._client.unregister_waiter(state.conn_id)
            raise

        deadline = time.time() + self._turn_timeout_s
        try:
            while True:
                if state.closed or (cancel_check is not None and cancel_check()):
                    return
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise BridgeTransportError("gateway turn timed out")
                try:
                    frame = waiter.get(timeout=min(remaining, 0.25))
                except queue.Empty:
                    continue
                kind = frame.get("kind")
                if kind == "transport_lost":
                    raise BridgeTransportError("bridge transport lost mid-turn")
                if kind == "prompt_rejected":
                    # Enumerated rejection (input gate etc.): no content;
                    # the server's own error path handles the outcome.
                    raise BridgeTransportError(f"gateway rejected the turn: {frame.get('code', 'rejected')}")
                if kind == "turn_started":
                    state.current_turn = frame.get("turnId")
                    continue
                if kind == "tts_sentence":
                    text = frame.get("text")
                    if isinstance(text, str) and text:
                        # Native ConnectionHandler.chat owns FIRST/TEXT/LAST.
                        # Writing to its TTS queue here as well duplicates the
                        # sentence and can reset an active encoder/session.
                        state.sentence_started = True
                        yield text
                    continue
                if kind == "tts_end":
                    self._enqueue_end(state, frame.get("reason"))
                    return
                # Unknown frame kinds never end the stream.
        finally:
            self._client.unregister_waiter(state.conn_id)

    @staticmethod
    def _extract_last_user_text(dialogue):
        if not isinstance(dialogue, list):
            return None
        for message in reversed(dialogue):
            if isinstance(message, dict) and message.get("role") == "user":
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        return None

    # ------------------------------------------------------------------
    # TTS termination handling (native chat owns the queue and device protocol)
    # ------------------------------------------------------------------

    def _enqueue_end(self, state, reason):
        conn = state.conn
        try:
            if reason in ("interrupted", "failed"):
                # The device-side stop: device aborts already ran the
                # server's native path; a LumiThink-initiated stop needs
                # the explicit stop message after the queue clear.
                conn.clear_queues()
                if reason == "failed":
                    self.schedule_stop(conn)
                state.sentence_started = False
                state.current_turn = None
                return
            # Native chat sends LAST after this generator returns. The audio
            # stop hook still needs current_turn for delivery accounting.
            state.sentence_started = False
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Fork-patch hooks (guarded try/except at every call site; all state
    # mutation happens on the control worker — a consistent single thread)
    # ------------------------------------------------------------------

    def lumi_on_hello(self, conn, conn_id):
        """Register the device connection AND announce it to the gateway.

        The gateway receives the REAL handshake material (Device-Id /
        Client-Id / Authorization from the server's verified connection)
        and maps it onto the guardian binding + connection lease.
        """
        state = _ConnState(conn, conn_id)
        with self._conns_lock:
            self._conns[getattr(conn, "session_id", None)] = state
        logger.bind(tag=TAG).warning("[lumi-bridge] device connection registered (announcing to the gateway)")
        headers = getattr(conn, "headers", {}) or {}
        welcome = getattr(conn, "welcome_msg", {}) or {}
        device_id = str(headers.get("device-id") or getattr(conn, "device_id") or "")
        session_id = welcome.get("session_id")

        def _announce():
            self._announce_connection(conn_id, device_id, headers, welcome, session_id)

        self._control.submit(_announce)

    def lumi_on_abort(self, conn):
        """Device abort (client_abort set server-side): flush accounting.

        QUEUED BEFORE the next chat's turn_prompt on the control FIFO (the
        upstream loop thread runs handleAbortMessage before submitting the
        next chat), so the gateway fences with the abort first.
        """
        session_id = getattr(conn, "session_id", None)
        self._control.submit(lambda: self._abort_state(session_id))

    def lumi_on_audio_frame(self, conn, opus_packet):
        """Real audio accounting: count + digest the ACTUAL bytes sent."""
        session_id = getattr(conn, "session_id", None)
        packet = bytes(opus_packet) if isinstance(opus_packet, (bytes, bytearray)) else None
        self._control.submit(lambda: self._account_audio(session_id, packet))

    def lumi_on_tts_state(self, conn, tts_state):
        """Fork hook on send_tts_message: flush accounting at utterance end."""
        if tts_state != "stop":
            return
        session_id = getattr(conn, "session_id", None)
        self._control.submit(lambda: self._stop_state(session_id))

    def lumi_on_device_closed(self, conn):
        """Device WebSocket closed: tell the gateway to release the lease.

        Without this frame the gateway's connection lease for the device
        stays open and every later hello fails with
        device_connection_conflict (the observed restart-retry loop)."""
        session_id = getattr(conn, "session_id", None)
        with self._conns_lock:
            state = self._conns.pop(session_id, None)
        if state is None:
            return
        state.closed = True
        conn_id = state.conn_id
        if not conn_id:
            return

        def _closed():
            try:
                self._client.send({
                    "kind": "device_closed",
                    "connId": conn_id,
                    "reason": "device",
                })
            except (BridgeTransportError, OSError):
                pass

        self._control.submit(_closed)

    # ------------------------------------------------------------------
    # Control-worker bodies (single-threaded state discipline)
    # ------------------------------------------------------------------

    def _announce_connection(self, conn_id, device_id, headers, welcome, session_id):
        try:
            self._client.ensure_connected()
            # Upstream's hello audio_params uses the v2.5.2 wire field name
            # `frame_duration`; the gateway contract expects
            # `frameDurationMs` — map it here (the bridge owns upstream
            # shape knowledge; the gateway stays strict, fail-closed).
            upstream_params = welcome.get("audio_params") or None
            audio_params = None
            if isinstance(upstream_params, dict) and upstream_params.get("format") == "opus":
                try:
                    audio_params = {
                        "format": "opus",
                        "sampleRate": int(upstream_params.get("sample_rate")),
                        "channels": int(upstream_params.get("channels")),
                        "frameDurationMs": int(upstream_params.get("frame_duration")),
                    }
                except (TypeError, ValueError):
                    audio_params = None
            # The Adapter contract's Device-Id grammar is the MAC
            # "separator-stripped and lower-cased by the transport"
            # (VOICE_GATEWAY_PROTOCOL §2.1) — the wire header carries
            # `aa:bb:cc:dd:ee:07`; the bridge IS the transport here.
            normalized_device_id = (
                device_id.replace(":", "").replace("-", "").replace(".", "").strip().lower()
            )
            self._client.send({
                "kind": "device_hello",
                "connId": conn_id,
                "deviceId": normalized_device_id,
                "deviceIdWire": device_id,
                "clientId": headers.get("client-id") or None,
                "authorization": headers.get("authorization") or None,
                "audioParams": audio_params,
            })
            if isinstance(session_id, str) and session_id:
                self._client.send({
                    "kind": "session_issued",
                    "connId": conn_id,
                    "xiaozhiSessionId": session_id,
                })
        except (BridgeTransportError, OSError):
            logger.bind(tag=TAG).warning("[lumi-bridge] gateway transport unavailable at hello (model calls will fail closed until it recovers)")

    def _abort_state(self, session_id):
        state = self._conns.get(session_id)
        if state is None:
            return
        self._flush_audio_locked(state, turn_id=state.current_turn)
        state.sentence_started = False
        state.current_turn = None

    def _stop_state(self, session_id):
        state = self._conns.get(session_id)
        if state is None:
            return
        self._flush_audio_locked(state, turn_id=state.current_turn)
        state.current_turn = None

    def _account_audio(self, session_id, packet):
        if packet is None:
            return
        state = self._conns.get(session_id)
        if state is None:
            return
        state.audio_frames += 1
        state.audio_digest.update(packet)

    def _flush_audio_locked(self, state, turn_id):
        if state.audio_frames <= 0:
            return
        digest = state.audio_digest.hexdigest()
        frames = state.audio_frames
        state.audio_frames = 0
        state.audio_digest = hashlib.sha256()
        try:
            self._client.send({
                "kind": "audio_delivered",
                "connId": state.conn_id,
                "turnId": turn_id,
                "frames": frames,
                "digest": digest,
            })
        except (BridgeTransportError, OSError):
            # Accounting is observability: a lost report must never break
            # the device path.
            pass

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def find_state_by_conn(self, conn_id):
        with self._conns_lock:
            for state in self._conns.values():
                if state.conn_id == conn_id:
                    return state
        return None

    def schedule_stop(self, conn):
        try:
            import asyncio

            from core.handle.sendAudioHandle import send_tts_message

            loop = getattr(conn, "loop", None)
            if loop is not None:
                asyncio.run_coroutine_threadsafe(send_tts_message(conn, "stop", None), loop)
        except Exception:
            pass

    def schedule_close(self, conn):
        try:
            import asyncio

            loop = getattr(conn, "loop", None)
            if loop is not None:
                asyncio.run_coroutine_threadsafe(conn.close(), loop)
        except Exception:
            pass
