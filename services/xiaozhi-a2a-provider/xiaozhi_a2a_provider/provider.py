"""XiaozhiA2AProvider (P2-03, issue #115; delivery watermark layer P2-04, #116).

The lightweight voice-channel adapter of A2A_DESIGN §10.1: it converts
LumiThink A2A Server tasks (status + artifact stream) into the text
generator the pinned xiaozhi server already consumes from the UDS bridge
(``deploy/xiaozhi/gateway_bridge/lumithink_llm.py`` — READ-ONLY shape
reference, NOT a dependency):

- ``lumi_on_hello(session_id)``        device hello registration (fail-closed gate);
- ``response(session_id, dialogue, cancel_check)``  sync generator yielding
  ONLY new admitted answer text (§9.3 contract enforcement);
- ``lumi_on_abort(session_id)``        device interrupt → explicit CancelTask
  on an independent short-timeout context (TASK_LIFECYCLE §7.4);
- ``lumi_on_device_closed(session_id)`` device disconnect → local playback
  stop only (an SSE/device drop NEVER cancels — §10.3).

Identity is carried exclusively by the device client credential
(``xiaozhi_device`` grant face: the device authenticates its household,
candidates never elevate). The provider never computes household rights and
never sends identity fields inside message content — forged user fields are
structurally impossible from this client.

Behavior contract (all content-free on failure; answer text never reaches
logs, exceptions or error messages):

- only NEW text is delivered: dedup by ``taskId + artifactId + chunkId``,
  UTF-8 byte-range continuity and SHA-256 verification via
  :mod:`.output_contract`; a breach fences playback for the turn and is
  recorded (§9.3/§10.1);
- explicit cancel only: a device interrupt (abort hook or ``cancel_check``)
  sends CancelTask through an INDEPENDENT client with the §7.3 timeout; an
  SSE disconnect is recovered via GetTask snapshot rebuild + a NEW
  SubscribeToTask (the #121-safe pattern — no new streaming send), never by
  auto-cancel and never by replaying the already-delivered prefix; a
  first-response loss recovers through ONE byte-identical resend with the
  SAME messageId (§5.3);
- playback completion is NOT task completion: a COMPLETED task with
  ``outputSuppressedAfterCancel=true`` is presented as
  "执行完成但回答未完整交付" without any replay;
- the official Python SDK (``a2a-sdk==1.2.3``) is imported lazily inside
  client construction, so this module stays importable in any environment;
  a missing SDK is a fatal, remedied error — never a silent skip.

This module has NO vendor/model SDK imports and NO model endpoint constants
(guarded by tests/test_structure_redline.py). Python ≥3.10 compatible.
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Generator, Iterable, List, Optional

from .delivery_ledger import (
    DELIVERY_STATE_COMPLETE,
    DELIVERY_STATE_PARTIAL_STOPPED,
    DELIVERY_STATE_UNCERTAIN,
    DeliveryLedgerError,
    FileDeliveryLedger,
    LEDGER_REASON_ANOMALY,
    MemoryDeliveryLedger,
    STATUS_DUPLICATE,
    STATUS_RECORDED,
    STATUS_STALE_GENERATION,
    STOP_DEVICE_ABORT,
    STOP_DEVICE_CLOSED,
)
from .output_contract import (
    AnswerStreamAccumulator,
    ContractViolation,
    IngestResult,
)

TAG = "xiaozhi_a2a_provider"
logger = logging.getLogger(TAG)
logger.addHandler(logging.NullHandler())  # library discipline: no handler guessing

DEFAULT_TOKEN_ENV = "LUMITHINK_XIAOZHI_DEVICE_TOKEN"
DEFAULT_TURN_TIMEOUT_S = 60.0
DEFAULT_CANCEL_TIMEOUT_S = 2.0   # §7.3 initial CancelTask response budget
DEFAULT_REQUEST_TIMEOUT_S = 30.0
DEFAULT_MAX_PROMPT_CHARS = 512   # same transient cap as the UDS bridge
QUEUE_SOFT_TIMEOUT_S = 0.25
MAX_RESEND_ATTEMPTS = 1          # §5.3 first-response-loss recovery, bounded
MAX_RESUBSCRIBE_ATTEMPTS = 1     # §9.3 reconnect, bounded
CRITICAL_PUSH_RETRY_S = 2.0      # P2-05 fix: settlement frames retry before an honest drop

# Enumerated, content-free failure reasons (stable evidence vocabulary).
REASON_SESSION_NOT_REGISTERED = "session_not_registered"
REASON_TURN_IN_PROGRESS = "turn_in_progress"
REASON_EMPTY_PROMPT = "empty_prompt"
REASON_PROMPT_TOO_LONG = "prompt_too_long"
REASON_SERVER_UNREACHABLE = "server_unreachable"
REASON_TURN_TIMEOUT = "turn_timeout"
REASON_STREAM_LOST = "stream_disconnected"
REASON_RECOVERY_EXHAUSTED = "recovery_exhausted"
REASON_CREDENTIAL_REJECTED = "credential_rejected"
REASON_CONTRACT_FENCE = "output_contract_fence"
REASON_CANCEL_UNCONFIRMED = "cancel_unconfirmed_timeout"
REASON_TASK_NOT_FOUND = "task_not_found"
REASON_CONTEXT_ACCESS_DENIED = "context_access_denied"
REASON_CONFLICT = "message_id_conflict"
REASON_SERVER_ERROR = "server_error"
REASON_DELIVERY_WATERMARK_UNRELIABLE = "delivery_watermark_unreliable"

# Presentation of the delivery status (A2A_DESIGN §10.2/§9.3).
PRESENTATION_COMPLETE = "complete"
PRESENTATION_COMPLETED_SUPPRESSED = "completed_but_suppressed"
PRESENTATION_CANCELED = "canceled"
PRESENTATION_FAILED = "failed"
PRESENTATION_ERROR = "error"

TERMINAL_STATES = (
    "TASK_STATE_COMPLETED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
)

# Wire error classes of the locked SDK mapped to enumerated reasons.
_WIRE_CODE_REASONS = {
    -32000: REASON_CREDENTIAL_REJECTED,
    -32001: REASON_TASK_NOT_FOUND,
    -32002: "already_terminal",
    -32004: "terminal_subscription_unsupported",
    -32602: REASON_CONTEXT_ACCESS_DENIED,
    -32603: REASON_SERVER_ERROR,
}


class ProviderConfigError(Exception):
    """Fail-closed construction/configuration error (content-free)."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("provider config error [{}]: {}".format(reason, detail))
        self.reason = reason
        self.detail = detail


class ProviderTurnError(Exception):
    """A turn failed for an enumerated, content-free reason."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("provider turn error [{}]: {}".format(reason, detail))
        self.reason = reason
        self.detail = detail


class _StreamLost(Exception):
    """Internal: the SSE stream ended without a terminal status (transport)."""

    def __init__(self, cause: Optional[BaseException] = None) -> None:
        super().__init__("stream lost before terminal status")
        self.cause = cause


@dataclass(frozen=True)
class _RequestId:
    """Neutral request shape for injected (test) clients."""

    id: str


def _struct_to_mapping(value: Any) -> Optional[Dict[str, Any]]:
    """Converts a google.protobuf Struct (proto-plus metadata shape) to dict."""
    fields = getattr(value, "fields", None)
    if fields is None or not hasattr(value, "WhichOneof"):
        return None
    try:
        from google.protobuf.json_format import MessageToDict

        converted = MessageToDict(value)
        return converted if isinstance(converted, dict) else None
    except Exception:  # pragma: no cover - defensive conversion fallback
        return None


def _as_mapping(value: Any) -> Dict[str, Any]:
    """Tolerant mapping view of proto-plus Struct metadata fields.

    proto-plus surfaces ``google.protobuf.Struct`` metadata as raw Struct
    objects; the locked-SDK JSON mapping (MessageToDict) restores the plain
    dict with the ORIGINAL keys (numbers arrive as JSON floats).
    """
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    converted = _struct_to_mapping(value)
    return converted if converted is not None else {}


def _state_name(state: Any) -> str:
    """Normalizes the SDK TaskState enum (int in the upb build) to its name."""
    if isinstance(state, str):
        return state
    try:
        from a2a.types import TaskState  # lazy: only on the SDK path

        return TaskState.Name(state)
    except Exception:  # pragma: no cover - defensive
        return str(state)


def _text_of_parts(parts: Iterable[Any]) -> str:
    """Concatenates the text parts of an artifact (§9.3 snapshot aggregate)."""
    chunks: List[str] = []
    for part in parts or ():
        try:
            which = part.WhichOneof("content")
        except Exception:  # pragma: no cover - defensive
            which = None
        if which == "text":
            value = getattr(part, "text", "")
            if isinstance(value, str):
                chunks.append(value)
    return "".join(chunks)


@dataclass(frozen=True)
class _DeliveredFragment:
    """The §9.3 identity of one delivered fragment (never the text itself).

    Rides through the bounded queue so the consumer thread can persist the
    channel-delivery watermark exactly when the text leaves the generator.
    """

    artifact_id: str
    chunk_id: str
    start_byte: int
    end_byte: int
    sha256: str


@dataclass
class TurnOutcome:
    """Content-free, per-turn evidence (what the channel may record)."""

    session_id: str
    message_id: str
    task_id: str = ""
    context_id: str = ""
    state: str = ""
    presentation: str = PRESENTATION_ERROR
    answer_complete: Optional[bool] = None
    output_suppressed_after_cancel: Optional[bool] = None
    cancel_requested: bool = False
    cancel_confirmed: Optional[bool] = None
    delivered_bytes: int = 0
    delivered_fragments: int = 0
    duplicate_fragments: int = 0
    contract_violations: int = 0
    contract_reasons: List[str] = field(default_factory=list)
    fenced: bool = False
    disconnected: bool = False
    resubscribed: bool = False
    resend_recovered: bool = False
    error_reason: Optional[str] = None
    # -- P2-04 channel-delivery watermark face (issue #116) ---------------
    generation: int = 0
    delivery_stopped: bool = False
    delivery_stop_reason: Optional[str] = None
    filtered_after_stop_fragments: int = 0
    stale_generation_fragments: int = 0
    watermark_write_failures: int = 0
    queue_full_drops: int = 0


@dataclass
class _SessionState:
    registered_at: float
    context_id: str = ""
    controller: Optional["_TurnController"] = None


class _TurnController:
    """Thread-safe bridge between the sync generator and the async turn."""

    def __init__(self, session_id: str, message_id: str, prompt: str, deadline: float) -> None:
        self.session_id = session_id
        self.message_id = message_id
        self.prompt = prompt
        self.deadline = deadline
        self.queue: "queue.Queue[tuple]" = queue.Queue(maxsize=64)
        self.cancel_requested = threading.Event()
        self.playback_stopped = threading.Event()  # local immediate 止播标记 (P2-04)
        self.consumer_gone = threading.Event()
        self.cancel_reason: Optional[str] = None
        self.task_id = ""
        self.context_id = ""
        self.generation = 0  # channel-delivery generation (ledger.begin_turn)
        self.outcome = TurnOutcome(session_id=session_id, message_id=message_id)
        self.accumulator = AnswerStreamAccumulator("")

    def request_cancel(self, reason: str) -> None:
        if not self.cancel_requested.is_set():
            self.cancel_reason = reason
            self.cancel_requested.set()
            self.outcome.cancel_requested = True
            logger.info("[%s] cancel intent recorded (%s) task=%s", TAG, reason, self.task_id or "pending")

    def stop_playback(self, reason: str) -> None:
        """Local immediate delivery/playback stop marker (issue #116 AC 3).

        Recorded BEFORE the CancelTask goes out (§10.3 step 1: 小智立即止播);
        late stream fragments are filtered against this marker.
        """
        if not self.playback_stopped.is_set():
            self.playback_stopped.set()
            self.outcome.delivery_stopped = True
            self.outcome.delivery_stop_reason = reason
            logger.info(
                "[%s] local playback/delivery stop recorded (%s) task=%s", TAG,
                reason, self.task_id or "pending",
            )

    def remaining(self) -> float:
        return max(0.05, self.deadline - time.monotonic())

    def expired(self) -> bool:
        return time.monotonic() >= self.deadline

    def push_text(self, text: str, meta: Optional[_DeliveredFragment] = None) -> bool:
        """Bounded handoff to the consumer; False when nobody is consuming.

        ``meta`` carries the §9.3 fragment identity so the consumer thread
        can persist the delivery watermark exactly when the text leaves the
        generator (the honest delivery point — §10.2 渠道交付).
        """
        while True:
            if self.consumer_gone.is_set() or self.expired():
                return False
            try:
                self.queue.put(("text", text, meta), timeout=QUEUE_SOFT_TIMEOUT_S)
                return True
            except queue.Full:
                continue

    def _push_critical(self, item: tuple, kind: str) -> None:
        """Bounded-retry handoff of a settlement frame (P2-03 review P2-⑤).

        A silently dropped ``end``/``error`` frame used to leave no trace;
        the fix retries briefly, then records the drop on the outcome and
        logs it (content-free) — the generator's worker-exit detection stays
        the fallback, and the evidence is now honest.
        """
        deadline = time.monotonic() + CRITICAL_PUSH_RETRY_S
        while True:
            try:
                self.queue.put(item, timeout=QUEUE_SOFT_TIMEOUT_S)
                return
            except queue.Full:
                if self.consumer_gone.is_set() or time.monotonic() >= deadline:
                    self.outcome.queue_full_drops += 1
                    logger.error(
                        "[%s] settlement frame dropped after bounded retry (kind=%s, drops=%d) task=%s",
                        TAG, kind, self.outcome.queue_full_drops, self.task_id or "unknown",
                    )
                    return

    def push_end(self) -> None:
        self._push_critical(("end", self.outcome, None), "end")

    def push_error(self, error: ProviderTurnError) -> None:
        self.outcome.error_reason = error.reason
        self._push_critical(("error", error, None), "error")


class XiaozhiA2AProvider:
    """Small-zhi-side A2A client adapter (official ``a2a-sdk`` inside).

    Config keys (dict, mirroring the pinned server's provider config style):

    - ``base_url`` (required): LumiThink A2A Server base URL (loopback in
      every validation deployment);
    - ``auth_token_env``: env var carrying the device client credential
      (default ``LUMITHINK_XIAOZHI_DEVICE_TOKEN``); the token may instead be
      injected explicitly via the ``auth_token`` constructor argument —
      either way it lives only in memory, never logged, never persisted;
    - ``session_grant_env`` / ``session_binding_env``: optional short-term
      grant headers (``X-Lumithink-Session-Grant`` / ``-Binding``); when
      configured, BOTH env vars MUST carry values (fail-closed);
    - ``turn_timeout_s`` (60), ``cancel_timeout_s`` (2.0, §7.3),
      ``request_timeout_s`` (30), ``max_prompt_chars`` (512);
    - ``continue_session_context``: continue the session's A2A context
      across turns (default True; new messageId + existing contextId → a
      new task in the same context, A2A_DESIGN §9.2);
    - ``delivery_ledger_path`` (P2-04): path of the durable channel-delivery
      watermark ledger (FileDeliveryLedger, atomic-write JSON — A2A_DESIGN
      §10.2/§11 and TASK_LIFECYCLE §6.2). When omitted, a process-local
      MemoryDeliveryLedger is used (honest for the process lifetime; durable
      deployments MUST wire a file path). A corrupt/unwritable ledger fails
      construction (fail-closed, reason ``delivery_ledger_unusable``).

    ``client_factory`` / ``cancel_client_factory`` are injection seams
    returning duck-typed async clients (``send_message/get_task/cancel_task/
    subscribe/aclose``) for isolated verification; production builds
    official-SDK clients on a per-context basis (the cancel context is
    always a separate short-timeout client, TASK_LIFECYCLE §7.4).
    """

    supports_cancel_check = True

    def __init__(
        self,
        config: Optional[Dict[str, Any]] = None,
        *,
        auth_token: Optional[str] = None,
        client_factory: Optional[Any] = None,
        cancel_client_factory: Optional[Any] = None,
    ) -> None:
        config = dict(config or {})
        base_url = config.get("base_url")
        if not isinstance(base_url, str) or not base_url.strip():
            raise ProviderConfigError("base_url_required", "base_url is required in the provider config")
        if not str(base_url).startswith(("http://", "https://")):
            raise ProviderConfigError("base_url_invalid", "base_url must be an http(s) URL")
        self._base_url = str(base_url).rstrip("/")

        self._client_factory = client_factory
        self._cancel_client_factory = cancel_client_factory if cancel_client_factory is not None else client_factory
        if client_factory is not None:
            if not callable(self._client_factory):
                raise ProviderConfigError("client_factory_invalid", "client_factory must be callable")
            if not callable(self._cancel_client_factory):
                raise ProviderConfigError("client_factory_invalid", "cancel_client_factory must be callable")

        token_env = str(config.get("auth_token_env", DEFAULT_TOKEN_ENV))
        token = auth_token
        if token is None:
            token = os.environ.get(token_env, "")
        if not isinstance(token, str) or not token:
            raise ProviderConfigError(
                "credential_missing",
                "env {} must carry the device client credential (fail-closed)".format(token_env),
            )
        self._token = token

        self._grant_headers: Dict[str, str] = {}
        grant_env = config.get("session_grant_env")
        binding_env = config.get("session_binding_env")
        if grant_env or binding_env:
            grant_value = os.environ.get(str(grant_env), "") if grant_env else ""
            binding_value = os.environ.get(str(binding_env), "") if binding_env else ""
            if not grant_value or not binding_value:
                raise ProviderConfigError(
                    "grant_headers_incomplete",
                    "session grant/binding env vars must both carry values (fail-closed)",
                )
            self._grant_headers = {
                "X-Lumithink-Session-Grant": grant_value,
                "X-Lumithink-Session-Binding": binding_value,
            }

        self._turn_timeout_s = float(config.get("turn_timeout_s", DEFAULT_TURN_TIMEOUT_S))
        self._cancel_timeout_s = float(config.get("cancel_timeout_s", DEFAULT_CANCEL_TIMEOUT_S))
        self._request_timeout_s = float(config.get("request_timeout_s", DEFAULT_REQUEST_TIMEOUT_S))
        self._max_prompt_chars = int(config.get("max_prompt_chars", DEFAULT_MAX_PROMPT_CHARS))
        self._continue_context = bool(config.get("continue_session_context", True))
        if self._turn_timeout_s <= 0 or self._cancel_timeout_s <= 0 or self._request_timeout_s <= 0:
            raise ProviderConfigError("timeouts_invalid", "timeouts must be positive")
        if self._max_prompt_chars <= 0:
            raise ProviderConfigError("max_prompt_chars_invalid", "max_prompt_chars must be positive")

        self._sessions: Dict[str, _SessionState] = {}
        self._lock = threading.Lock()
        self._agent_card: Any = None
        self._last_outcomes: Dict[str, TurnOutcome] = {}

        # -- P2-04 channel-delivery watermark ledger (issue #116) ----------
        ledger_path = config.get("delivery_ledger_path")
        if ledger_path is not None:
            if not isinstance(ledger_path, str) or not ledger_path.strip():
                raise ProviderConfigError(
                    "delivery_ledger_path_invalid",
                    "delivery_ledger_path must be a non-empty string when provided",
                )
            try:
                self._delivery_ledger = FileDeliveryLedger(ledger_path)
            except DeliveryLedgerError as error:
                raise ProviderConfigError(
                    "delivery_ledger_unusable",
                    "the channel-delivery ledger refuses to open (fail-closed): "
                    "{} — repair or move aside the ledger file".format(error.reason),
                ) from error
        else:
            self._delivery_ledger = MemoryDeliveryLedger()
            logger.info(
                "[%s] delivery ledger is process-local (wire delivery_ledger_path for a durable watermark)", TAG,
            )

        # Fail fast on a missing official SDK (the ZERO-SKIP contract: a
        # missing interpreter/SDK must be an explicit, remedied error —
        # never a silent degradation). The import stays lazy at module load
        # so the module itself imports in any environment.
        self._load_sdk()
        logger.info(
            "[%s] initialized (base=%s, official a2a-sdk client, credential=%s, grants=%s)",
            TAG, self._base_url, "explicit" if auth_token is not None else token_env,
            "on" if self._grant_headers else "off",
        )

    # ------------------------------------------------------------------
    # Integration face (same shape as deploy/xiaozhi/gateway_bridge)
    # ------------------------------------------------------------------

    def lumi_on_hello(self, session_id: str, device_hint: str = "") -> None:
        """Registers a device session; turns fail closed without it."""
        if not isinstance(session_id, str) or not session_id:
            raise ProviderConfigError("session_id_required", "session_id is required at hello")
        with self._lock:
            self._sessions[session_id] = _SessionState(registered_at=time.monotonic())
        # device_hint is content-free metadata (e.g. a masked device id) and
        # is never needed for authorization — the credential carries identity.
        logger.info("[%s] device session registered session=%s", TAG, session_id)

    def lumi_on_device_closed(self, session_id: str) -> None:
        """Device WebSocket closed: stop local playback bookkeeping only.

        This never cancels the A2A task (§10.3: disconnect ≠ cancel); the
        server-side execution deadline owns any orphaned execution. The
        delivery watermark records the stop as "uncertain" (§10.2: 反馈不足
        时记录交付不确定).
        """
        with self._lock:
            state = self._sessions.pop(session_id, None)
        if state is None:
            return
        controller = state.controller
        if controller is not None:
            controller.consumer_gone.set()
            controller.stop_playback(STOP_DEVICE_CLOSED)
            self._record_ledger_stop(session_id, STOP_DEVICE_CLOSED, DELIVERY_STATE_UNCERTAIN)
            logger.info(
                "[%s] device session closed session=%s task=%s (playback stops; no cancel sent)",
                TAG, session_id, controller.task_id or "unknown",
            )
        else:
            logger.info("[%s] device session closed session=%s (no active turn)", TAG, session_id)

    def lumi_on_abort(self, session_id: str) -> Dict[str, Any]:
        """Device interrupt: records the cancel intent (never blocks/raises).

        The local stop-playback marker is set FIRST (§10.3 step 1: 小智立即
        止播，清理旧轮音频队列), the durable delivery stop lands in the
        ledger, and the actual CancelTask runs on the turn worker through an
        INDEPENDENT short-timeout client (§7.4). The returned snapshot is
        content-free.
        """
        with self._lock:
            state = self._sessions.get(session_id)
            controller = state.controller if state is not None else None
        if controller is None:
            return {"status": "no_active_turn", "sessionId": session_id}
        controller.stop_playback(STOP_DEVICE_ABORT)
        self._record_ledger_stop(session_id, STOP_DEVICE_ABORT, DELIVERY_STATE_PARTIAL_STOPPED)
        controller.request_cancel("device_abort")
        return {
            "status": "cancel_intent_recorded",
            "sessionId": session_id,
            "taskId": controller.task_id,
            "playbackStopped": True,
        }

    def _record_ledger_stop(self, session_id: str, reason: str, delivery_state: str) -> None:
        """Durable stop marker; the interrupt path never raises on ledger damage."""
        try:
            self._delivery_ledger.record_stop(session_id, reason, delivery_state)
        except DeliveryLedgerError as error:
            logger.warning(
                "[%s] delivery stop marker failed reason=%s session=%s", TAG, error.reason, session_id
            )

    def last_outcome(self, session_id: str) -> Optional[TurnOutcome]:
        """The most recent content-free turn outcome for the session."""
        with self._lock:
            state = self._sessions.get(session_id)
        if state is not None and state.controller is not None:
            return state.controller.outcome
        with self._lock:
            return self._last_outcomes.get(session_id)

    def delivery_summary(self, session_id: str) -> Optional[Dict[str, Any]]:
        """The content-free channel-delivery record of the latest turn.

        A2A_DESIGN §10.2's optional delivery-digest face: delivered
        fragments/bytes, stop reason, delivery state, and the READ-ONLY
        observed terminal Task flags (playback completion is recorded next
        to — never instead of — the Task state). Missing = unknown, and it
        never blocks the agent.
        """
        try:
            return self._delivery_ledger.delivery_summary(session_id)
        except DeliveryLedgerError:  # pragma: no cover - defensive
            return None

    def response(
        self,
        session_id: str,
        dialogue: Any,
        cancel_check: Optional[Any] = None,
    ) -> Generator[str, None, None]:
        """Streams admitted answer text for one voice turn (sync generator).

        Mirrors the UDS bridge's ``response(session_id, dialogue,
        cancel_check)``: only the last user message crosses to LumiThink;
        the conversation state lives behind the trusted server. Raises
        (fail-closed, content-free) instead of ever falling back.
        """
        with self._lock:
            state = self._sessions.get(session_id)
        if state is None:
            # Fail closed: an unregistered session can never be authorized.
            logger.warning("[%s] turn rejected: session not registered", TAG)
            raise ProviderTurnError(REASON_SESSION_NOT_REGISTERED, "no hello-registered session")
        with self._lock:
            if state.controller is not None:
                raise ProviderTurnError(REASON_TURN_IN_PROGRESS, "one in-flight turn per session")
        prompt = self._extract_last_user_text(dialogue)
        if not prompt:
            raise ProviderTurnError(REASON_EMPTY_PROMPT, "no usable user text in the dialogue")
        if len(prompt) > self._max_prompt_chars:
            raise ProviderTurnError(REASON_PROMPT_TOO_LONG, "prompt exceeds the transient cap")

        message_id = "xz-{}".format(uuid.uuid4())
        controller = _TurnController(
            session_id=session_id,
            message_id=message_id,
            prompt=prompt,
            deadline=time.monotonic() + self._turn_timeout_s,
        )
        controller.context_id = state.context_id if self._continue_context else ""
        # P2-04: a new voice turn invalidates the previous turn's delivery
        # watermark (ledger generation bump — issue #116 AC 5). A failing
        # ledger fails the turn explicitly: delivering without any watermark
        # basis would make the reconnect gate meaningless.
        try:
            controller.generation = self._delivery_ledger.begin_turn(session_id)
            controller.outcome.generation = controller.generation
        except DeliveryLedgerError as error:
            raise ProviderTurnError(
                REASON_DELIVERY_WATERMARK_UNRELIABLE,
                "delivery ledger unusable at turn start ({})".format(error.reason),
            ) from error
        with self._lock:
            state.controller = controller
        worker = threading.Thread(
            target=self._run_turn_thread, args=(controller,), daemon=True, name="xz-a2a-turn"
        )
        logger.info(
            "[%s] turn submitting session=%s message=%s context=%s",
            TAG, session_id, message_id, controller.context_id or "new",
        )
        worker.start()
        try:
            while True:
                if cancel_check is not None and not controller.cancel_requested.is_set():
                    try:
                        if cancel_check():
                            controller.request_cancel("cancel_check")
                    except Exception:  # a broken callback must not kill the turn
                        logger.warning("[%s] cancel_check callback raised; ignored", TAG)
                try:
                    kind, payload, meta = controller.queue.get(timeout=QUEUE_SOFT_TIMEOUT_S)
                except queue.Empty:
                    if not worker.is_alive() and controller.queue.empty():
                        break
                    continue
                if kind == "text":
                    if meta is not None and not self._gate_channel_delivery(controller, meta):
                        continue  # duplicate / stale-generation: never handed over twice
                    yield payload
                elif kind == "end":
                    return
                else:  # error
                    raise payload
        finally:
            # Normal end, consumer abandonment (GeneratorExit) and errors all
            # land here: stop the worker without ever implying a cancel.
            controller.consumer_gone.set()
            worker.join(timeout=5.0)
            if worker.is_alive():  # pragma: no cover - defensive
                logger.warning("[%s] turn worker still draining after close (daemon)", TAG)
            with self._lock:
                state.controller = None
                self._last_outcomes[session_id] = controller.outcome
                if controller.outcome.context_id:
                    state.context_id = controller.outcome.context_id

    # ------------------------------------------------------------------
    # Turn internals (worker thread → event loop)
    # ------------------------------------------------------------------

    def _run_turn_thread(self, controller: _TurnController) -> None:
        try:
            asyncio.run(self._run_turn_async(controller))
        except ProviderTurnError as error:
            logger.warning("[%s] turn failed reason=%s", TAG, error.reason)
            controller.push_error(error)
        except Exception as exc:  # pragma: no cover - defensive last resort
            logger.exception("[%s] turn crashed (content-free)", TAG)
            controller.push_error(ProviderTurnError(REASON_SERVER_ERROR, type(exc).__name__))

    def _extract_last_user_text(self, dialogue: Any) -> str:
        if not isinstance(dialogue, list):
            return ""
        for message in reversed(dialogue):
            if isinstance(message, dict) and message.get("role") == "user":
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        return ""

    # -- channel-delivery watermark (P2-04, issue #116) --------------------

    def _gate_channel_delivery(self, controller: _TurnController, meta: _DeliveredFragment) -> bool:
        """The final delivery gate, exactly when text leaves the generator.

        The §9.3 accumulator already enforced dedup/continuity/digest; this
        gate persists the consumer-side watermark under the stable ids
        (issue #116 AC 1) and blocks what must never reach the consumer:

        - ``stale_generation`` — a fragment of a superseded turn (AC 5: old
          content never enters the new turn);
        - ledger ``duplicate`` — defensive second delivery of the same
          stable fragment.

        A ledger WRITE failure cannot un-deliver a §9.3-validated fragment,
        so delivery proceeds, the failure is counted (watermark uncertainty
        is honest — §10.2) and the reconnect gate will fail closed if the
        durable copy is actually damaged.
        """
        outcome = controller.outcome
        try:
            status = self._delivery_ledger.record_delivery(
                session_id=controller.session_id,
                generation=controller.generation,
                task_id=controller.task_id,
                artifact_id=meta.artifact_id,
                chunk_id=meta.chunk_id,
                start_byte=meta.start_byte,
                end_byte=meta.end_byte,
                sha256=meta.sha256,
            )
        except DeliveryLedgerError as error:
            if error.reason == LEDGER_REASON_ANOMALY:
                # Durable-layer protocol anomaly (same stable id re-delivered
                # with a different range/digest, or a watermark rewind): the
                # §9.3 fence discipline is the backstop here too — the
                # fragment is NEVER played from a fenced stream, and the
                # breach is recorded with an enumerated, content-free reason.
                self._fence_on_violation(
                    controller, ContractViolation(error.reason, error.detail)
                )
                return False
            # Disk-level failures (ledger_unwritable ...) cannot un-deliver a
            # §9.3-validated fragment: delivery proceeds with the uncertainty
            # counted (§10.2 交付不确定) and the reconnect gate will fail
            # closed if the durable copy is actually damaged.
            outcome.watermark_write_failures += 1
            logger.warning(
                "[%s] delivery watermark record failed reason=%s task=%s (delivery uncertainty recorded)",
                TAG, error.reason, controller.task_id or "unknown",
            )
            return True
        if status == STATUS_STALE_GENERATION:
            outcome.stale_generation_fragments += 1
            logger.warning(
                "[%s] stale-generation fragment blocked task=%s (old-turn content never enters a new turn)",
                TAG, controller.task_id or "unknown",
            )
            return False
        if status == STATUS_DUPLICATE:
            outcome.duplicate_fragments += 1
            logger.warning(
                "[%s] ledger-duplicate fragment blocked task=%s", TAG, controller.task_id or "unknown"
            )
            return False
        if status == STATUS_RECORDED:
            outcome.delivered_fragments += 1
            outcome.delivered_bytes += max(0, meta.end_byte - meta.start_byte)
        return True

    # -- official SDK wiring (lazy; zero third-party imports at module load)

    def _load_sdk(self) -> Dict[str, Any]:
        try:
            import httpx
            from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
            from a2a.types import (
                CancelTaskRequest,
                GetTaskRequest,
                Message,
                Part,
                Role,
                SendMessageRequest,
                SubscribeToTaskRequest,
            )
        except ImportError as exc:
            raise ProviderConfigError(
                "official_sdk_missing",
                "the official A2A Python SDK is required: pip install a2a-sdk==1.2.3",
            ) from exc
        return {
            "httpx": httpx,
            "A2ACardResolver": A2ACardResolver,
            "ClientConfig": ClientConfig,
            "ClientFactory": ClientFactory,
            "CancelTaskRequest": CancelTaskRequest,
            "GetTaskRequest": GetTaskRequest,
            "Message": Message,
            "Part": Part,
            "Role": Role,
            "SendMessageRequest": SendMessageRequest,
            "SubscribeToTaskRequest": SubscribeToTaskRequest,
        }

    def _wire_error_reason(self, error: Exception) -> str:
        try:
            from a2a.utils.errors import JSON_RPC_ERROR_CODE_MAP

            code = JSON_RPC_ERROR_CODE_MAP.get(type(error))
        except Exception:  # pragma: no cover - SDK absent
            code = None
        return _WIRE_CODE_REASONS.get(code, REASON_SERVER_ERROR)

    def _credential_rejection(self, exc: Exception) -> bool:
        """True for 401/403-shaped rejections (typed, HTTP status, or cause).

        The locked SDK wraps HTTP errors: ``A2AClientError('HTTP Error 401:
        …')`` with the original ``httpx.HTTPStatusError`` as ``__cause__`` —
        walk the bounded cause chain before deciding.
        """
        seen = 0
        current: Optional[BaseException] = exc
        while current is not None and seen < 5:
            if self._wire_error_reason(current) == REASON_CREDENTIAL_REJECTED:
                return True
            response = getattr(current, "response", None)
            status = getattr(response, "status_code", None)
            if status in (401, 403):
                return True
            try:
                import httpx  # lazy; SDK stack only

                if isinstance(current, httpx.HTTPStatusError) and current.response.status_code in (401, 403):
                    return True
            except Exception:  # pragma: no cover - httpx absent
                pass
            current = current.__cause__ or current.__context__
            seen += 1
        return False

    async def _resolve_agent_card(self, sdk: Dict[str, Any], http_client: Any) -> Any:
        if self._agent_card is not None:
            return self._agent_card
        try:
            card = await sdk["A2ACardResolver"](
                httpx_client=http_client, base_url=self._base_url
            ).get_agent_card()
        except Exception as exc:
            if self._credential_rejection(exc):
                raise ProviderTurnError(
                    REASON_CREDENTIAL_REJECTED, "credential rejected at agent card discovery"
                ) from exc
            raise ProviderTurnError(REASON_SERVER_UNREACHABLE, "agent card discovery failed") from exc
        self._agent_card = card
        return card

    def _open_official_client(self, sdk: Dict[str, Any], timeout_s: float) -> Any:
        httpx = sdk["httpx"]
        provider = self

        class _OfficialClient:
            """One official-SDK client bound to ONE short-lived httpx context."""

            def __init__(self) -> None:
                self._http = httpx.AsyncClient(timeout=timeout_s, headers=provider._auth_headers())
                self._a2a: Any = None

            async def _ensure_a2a(self) -> Any:
                if self._a2a is None:
                    card = await provider._resolve_agent_card(sdk, self._http)
                    self._a2a = sdk["ClientFactory"](
                        sdk["ClientConfig"](httpx_client=self._http, streaming=True)
                    ).create(card)
                return self._a2a

            async def send_message(self, request: Any) -> Any:
                a2a = await self._ensure_a2a()
                return a2a.send_message(request)

            async def get_task(self, request: Any) -> Any:
                a2a = await self._ensure_a2a()
                return await a2a.get_task(request)

            async def cancel_task(self, request: Any) -> Any:
                a2a = await self._ensure_a2a()
                return await a2a.cancel_task(request)

            async def subscribe(self, request: Any) -> Any:
                a2a = await self._ensure_a2a()
                return a2a.subscribe(request)

            async def aclose(self) -> None:
                await self._http.aclose()

        return _OfficialClient()

    async def _open_turn_client(self) -> Any:
        if self._client_factory is not None:
            return self._client_factory()
        return self._open_official_client(self._load_sdk(), self._request_timeout_s)

    async def _open_cancel_client(self) -> Any:
        # §7.4: the cleanup request runs on an INDEPENDENT client/timeout,
        # never on the (possibly broken) turn stream context.
        if self._cancel_client_factory is not None:
            return self._cancel_client_factory()
        return self._open_official_client(self._load_sdk(), self._cancel_timeout_s)

    def _auth_headers(self) -> Dict[str, str]:
        headers = {"Authorization": "Bearer {}".format(self._token)}
        headers.update(self._grant_headers)
        return headers

    # -- the async turn ---------------------------------------------------

    async def _run_turn_async(self, controller: _TurnController) -> None:
        sdk = self._load_sdk()
        turn_client = await self._open_turn_client()
        try:
            await self._send_and_consume(controller, sdk, turn_client)
        finally:
            try:
                await turn_client.aclose()
            except Exception:  # pragma: no cover - close is best-effort
                pass

    async def _send_and_consume(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any
    ) -> None:
        # Identity fields NEVER ride in message content — the credential
        # binding is the only identity (ADR-0014 §3).
        message = sdk["Message"](
            message_id=controller.message_id,
            role=sdk["Role"].ROLE_USER,
            parts=[sdk["Part"](text=controller.prompt)],
        )
        if controller.context_id:
            message.context_id = controller.context_id

        resend_attempts = 0
        resubscribe_attempts = 0
        while True:
            request = sdk["SendMessageRequest"](message=message)
            try:
                stream = await turn_client.send_message(request)
            except ProviderTurnError:
                raise
            except Exception as exc:
                # The send itself failed at transport level: the task may or
                # may not exist (first-response loss semantics, §5.3).
                await self._recover_from_send_failure(
                    controller, sdk, turn_client, exc, message, resend_attempts
                )
                return
            try:
                await self._consume_stream(controller, sdk, turn_client, stream)
                return
            except _StreamLost as lost:
                plan = await self._recover_from_stream_loss(
                    controller, sdk, turn_client, lost, message,
                    resend_attempts, resubscribe_attempts,
                )
                if plan == "resend":
                    resend_attempts += 1
                    controller.outcome.resend_recovered = True
                    continue  # byte-identical resend: SAME messageId (§5.3)
                if plan == "resubscribed":
                    resubscribe_attempts += 1
                return

    async def _consume_stream(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any, stream: Any
    ) -> None:
        """Consumes one SendStreamingMessage/SubscribeToTask stream.

        The stream event wait is a POLLING wait (asyncio.wait with a short
        timeout — the SDK's ``__anext__`` task is NEVER cancelled while
        pending): this lets a silent stream still observe a device
        interrupt, a consumer departure and the turn deadline promptly.
        """
        iterator = stream.__aiter__()
        anext_task: Optional[asyncio.Future] = None
        try:
            while True:
                if anext_task is None:
                    anext_task = asyncio.ensure_future(iterator.__anext__())
                wait_s = 0.1 if controller.cancel_requested.is_set() else min(controller.remaining(), 0.5)
                done, _pending = await asyncio.wait({anext_task}, timeout=wait_s)
                if anext_task not in done:
                    # No stream event yet: handle the interrupt/gone/deadline
                    # transitions that must never wait for upstream output.
                    if controller.cancel_requested.is_set() and controller.task_id:
                        await self._execute_cancel_and_finish(controller, sdk, turn_client)
                        return
                    if controller.cancel_requested.is_set():
                        continue  # interrupt before the id: keep waiting (§10.4)
                    if controller.consumer_gone.is_set():
                        return
                    if controller.expired():
                        logger.warning(
                            "[%s] turn deadline reached task=%s (no cancel sent)", TAG,
                            controller.task_id or "unknown",
                        )
                        controller.push_error(
                            ProviderTurnError(REASON_TURN_TIMEOUT, "turn exceeded the configured deadline")
                        )
                        return
                    continue
                task = anext_task
                anext_task = None
                try:
                    response = task.result()
                except asyncio.CancelledError:  # pragma: no cover - defensive
                    raise
                except StopAsyncIteration:
                    if controller.outcome.state in TERMINAL_STATES:
                        await self._finalize_terminal(controller, sdk, turn_client)
                        return
                    # Stream closed without a terminal status: a disconnect,
                    # never a cancel (§10.3) — the recovery path decides.
                    raise _StreamLost()
                except Exception as exc:
                    if controller.consumer_gone.is_set():
                        return
                    raise _StreamLost(exc)

                await self._handle_payload(controller, sdk, turn_client, response)
                if controller.outcome.state in TERMINAL_STATES:
                    await self._finalize_terminal(controller, sdk, turn_client)
                    return
                if controller.cancel_requested.is_set() and controller.task_id:
                    # Device interrupt with a known task: explicit CancelTask.
                    await self._execute_cancel_and_finish(controller, sdk, turn_client)
                    return
                # Interrupt before the id / consumer flow checks ride the
                # poll branch above; plain events just keep consuming.
        finally:
            if anext_task is not None and not anext_task.done():
                anext_task.cancel()

    async def _handle_payload(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any, response: Any
    ) -> None:
        which = response.WhichOneof("payload")
        if which == "task":
            task = response.task
            controller.task_id = task.id
            controller.outcome.task_id = task.id
            if getattr(task, "context_id", ""):
                controller.outcome.context_id = task.context_id
            controller.accumulator.task_id = task.id
            controller.outcome.state = _state_name(task.status.state)
            logger.info("[%s] task frame task=%s state=%s", TAG, task.id, controller.outcome.state)
        elif which == "artifact_update":
            event = response.artifact_update
            artifact = event.artifact
            artifact_id = artifact.artifact_id
            text = _text_of_parts(artifact.parts)
            try:
                result = controller.accumulator.ingest_event(
                    artifact_id=artifact_id,
                    artifact_metadata=_as_mapping(artifact.metadata),
                    event_metadata=_as_mapping(event.metadata),
                    text=text,
                    append=bool(event.append),
                    last_chunk=bool(event.last_chunk),
                )
            except ContractViolation as violation:
                self._fence_on_violation(controller, violation)
                return
            if not result.playable:
                return  # structured data never reaches speech (§9.3)
            if result.duplicate:
                controller.outcome.duplicate_fragments += 1
                return
            if (
                controller.outcome.fenced
                or controller.cancel_requested.is_set()
                or controller.playback_stopped.is_set()
            ):
                # Fenced runs, interrupted turns and locally stopped playback
                # never deliver further (issue #116 AC 3): late arrivals are
                # counted and durably recorded, never played (§6.2 已发入网络
                # 或已播放的内容不能撤回，应由渠道进一步止播).
                controller.outcome.filtered_after_stop_fragments += 1
                if controller.task_id:
                    try:
                        self._delivery_ledger.record_filtered(
                            controller.session_id, controller.task_id, controller.generation
                        )
                    except DeliveryLedgerError:
                        pass  # the outcome counter above stays the honest record
                return
            controller.push_text(
                result.new_text,
                _DeliveredFragment(
                    artifact_id=result.artifact_id,
                    chunk_id=result.chunk_id,
                    start_byte=result.start_byte,
                    end_byte=result.end_byte,
                    sha256=result.sha256,
                ),
            )
        elif which == "status_update":
            status = response.status_update
            controller.outcome.state = _state_name(status.status.state)
            if controller.task_id == "" and getattr(status, "task_id", ""):
                controller.task_id = status.task_id
                controller.accumulator.task_id = controller.task_id
        elif which == "message":
            # LumiThink answers Task-first (design §9.2); a bare message
            # payload would breach that contract — never played.
            logger.warning("[%s] unexpected bare message payload (ignored)", TAG)
        else:
            logger.warning("[%s] unknown stream payload kind=%r (ignored)", TAG, which)

    def _fence_on_violation(self, controller: _TurnController, violation: ContractViolation) -> None:
        """A contract breach stops playback for the turn (§9.3 fail-closed)."""
        first = not controller.outcome.fenced
        controller.outcome.fenced = True
        controller.outcome.contract_violations += 1
        if violation.reason not in controller.outcome.contract_reasons:
            controller.outcome.contract_reasons.append(violation.reason)
        controller.outcome.error_reason = REASON_CONTRACT_FENCE
        if first:
            logger.error(
                "[%s] OUTPUT CONTRACT VIOLATION reason=%s detail=%s task=%s (playback fenced)",
                TAG, violation.reason, violation.detail, controller.task_id or "unknown",
            )
        # Consumption continues silently to terminal so the task settlement
        # stays honest; no further text is ever played from a fenced stream.

    async def _finalize_terminal(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any
    ) -> None:
        # Playback completion is NOT task completion: confirm the terminal
        # state and the lumithinkResult flags through the authorized
        # snapshot (§7.2 — never infer a full answer from the status event).
        snapshot = await self._snapshot_bounded(controller, sdk, turn_client)
        await self._apply_terminal_outcome(controller, snapshot)
        logger.info(
            "[%s] turn settled task=%s state=%s presentation=%s fragments=%d (+%d dup) bytes=%d",
            TAG, controller.outcome.task_id, controller.outcome.state,
            controller.outcome.presentation, controller.outcome.delivered_fragments,
            controller.outcome.duplicate_fragments, controller.outcome.delivered_bytes,
        )
        controller.push_end()

    async def _snapshot_bounded(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any, timeout_s: float = 3.0
    ) -> Optional[Any]:
        if not controller.task_id:
            return None
        try:
            return await asyncio.wait_for(
                turn_client.get_task(sdk["GetTaskRequest"](id=controller.task_id)),
                timeout=timeout_s,
            )
        except Exception as exc:
            logger.warning(
                "[%s] snapshot confirmation failed task=%s (%s)", TAG,
                controller.task_id, type(exc).__name__,
            )
            return None

    async def _apply_terminal_outcome(self, controller: _TurnController, snapshot: Any) -> None:
        """Maps the terminal task (+ lumithinkResult flags) to the outcome."""
        state = controller.outcome.state
        if snapshot is not None:
            state = _state_name(snapshot.status.state)
            controller.outcome.state = state
            if getattr(snapshot, "context_id", ""):
                controller.outcome.context_id = snapshot.context_id
            flags = _as_mapping(_as_mapping(getattr(snapshot, "metadata", None)).get("lumithinkResult"))
            if flags.get("version") == 1:
                controller.outcome.answer_complete = bool(flags.get("answerComplete"))
                controller.outcome.output_suppressed_after_cancel = bool(
                    flags.get("outputSuppressedAfterCancel")
                )
        if state == "TASK_STATE_COMPLETED":
            if controller.outcome.output_suppressed_after_cancel is True:
                # 执行完成但回答未完整交付 (§9.3/§7.2): present honestly,
                # never a fabricated full answer and never a replay.
                controller.outcome.presentation = PRESENTATION_COMPLETED_SUPPRESSED
            else:
                controller.outcome.presentation = PRESENTATION_COMPLETE
        elif state == "TASK_STATE_CANCELED":
            controller.outcome.presentation = PRESENTATION_CANCELED
        elif state in ("TASK_STATE_FAILED", "TASK_STATE_REJECTED"):
            controller.outcome.presentation = PRESENTATION_FAILED
        else:
            controller.outcome.presentation = PRESENTATION_ERROR
        self._record_settlement_observation(controller)

    def _record_settlement_observation(self, controller: _TurnController) -> None:
        """Persists the settlement as a channel-side READ-ONLY observation.

        播放完成 ≠ Task 完成 (issue #116 AC 4): the observed Task state and
        the lumithinkResult flags land NEXT TO the delivery state in the
        ledger — never instead of it, and never fed back into any task
        authority (the server-side SQLite store stays the only lifecycle
        authority, the P2-02 boundary statement).
        """
        if not controller.task_id:
            return
        presentation = controller.outcome.presentation
        if controller.outcome.fenced:
            # A fenced turn's delivery cannot be called complete even when
            # the task itself completed: the channel refused part of the
            # admitted stream (§9.3) — the delivery record stays honest.
            delivery_state = DELIVERY_STATE_UNCERTAIN
        elif presentation == PRESENTATION_COMPLETE:
            delivery_state = DELIVERY_STATE_COMPLETE
        elif presentation in (PRESENTATION_COMPLETED_SUPPRESSED, PRESENTATION_CANCELED):
            delivery_state = DELIVERY_STATE_PARTIAL_STOPPED
        else:
            delivery_state = DELIVERY_STATE_UNCERTAIN
        try:
            self._delivery_ledger.record_task_observation(
                session_id=controller.session_id,
                task_id=controller.task_id,
                generation=controller.generation,
                task_state=controller.outcome.state,
                answer_complete=controller.outcome.answer_complete,
                output_suppressed_after_cancel=controller.outcome.output_suppressed_after_cancel,
                delivery_state=delivery_state,
            )
        except DeliveryLedgerError as error:
            controller.outcome.watermark_write_failures += 1
            logger.warning(
                "[%s] settlement observation record failed reason=%s task=%s",
                TAG, error.reason, controller.task_id,
            )

    # -- cancel (§7.4: independent context) --------------------------------

    async def _execute_cancel_and_finish(
        self, controller: _TurnController, sdk: Dict[str, Any], turn_client: Any
    ) -> None:
        outcome = controller.outcome
        outcome.cancel_requested = True
        task_id = controller.task_id
        if not task_id:  # pragma: no cover - callers guarantee the id
            controller.push_end()
            return
        cancel_client = await self._open_cancel_client()
        try:
            try:
                canceled = await asyncio.wait_for(
                    cancel_client.cancel_task(sdk["CancelTaskRequest"](id=task_id)),
                    timeout=self._cancel_timeout_s,
                )
                outcome.state = _state_name(canceled.status.state)
                outcome.cancel_confirmed = outcome.state == "TASK_STATE_CANCELED"
            except asyncio.TimeoutError:
                # §7.3/§7.4: unconfirmed ≠ cancelled intent lost — record,
                # never pretend success; the intent and the server-side
                # deadline keep working.
                outcome.cancel_confirmed = False
                outcome.error_reason = REASON_CANCEL_UNCONFIRMED
                logger.warning(
                    "[%s] cancel unconfirmed within %.1fs task=%s (query the task for the true state)",
                    TAG, self._cancel_timeout_s, task_id,
                )
            except Exception as exc:
                reason = self._wire_error_reason(exc)
                if reason == "already_terminal":
                    # §7.2: cancel lost the race to a terminal task — the
                    # actual state is authoritative, never a fabricated cancel.
                    snapshot = await self._snapshot_bounded(controller, sdk, turn_client)
                    await self._apply_terminal_outcome(controller, snapshot)
                    outcome.cancel_confirmed = False
                else:
                    outcome.cancel_confirmed = False
                    outcome.error_reason = reason
                    logger.warning(
                        "[%s] cancel request failed reason=%s task=%s", TAG, reason, task_id
                    )
        finally:
            try:
                await cancel_client.aclose()
            except Exception:  # pragma: no cover
                pass
        if outcome.state in TERMINAL_STATES:
            await self._apply_terminal_outcome(controller, None)
        logger.info(
            "[%s] cancel settled task=%s state=%s confirmed=%s",
            TAG, task_id, outcome.state, outcome.cancel_confirmed,
        )
        controller.push_end()

    # -- recovery (§9.3 + #121-safe; disconnect never cancels) --------------

    async def _recover_from_send_failure(
        self,
        controller: _TurnController,
        sdk: Dict[str, Any],
        turn_client: Any,
        cause: Exception,
        message: Any,
        resend_attempts: int,
    ) -> None:
        if controller.consumer_gone.is_set():
            return
        if self._credential_rejection(cause):
            # 401/403 never improves through a resend: fail explicitly.
            raise ProviderTurnError(REASON_CREDENTIAL_REJECTED, "credential rejected during send") from cause
        logger.warning(
            "[%s] send failed before the stream task=%s (%s)", TAG,
            controller.task_id or "unknown", type(cause).__name__,
        )
        if resend_attempts < MAX_RESEND_ATTEMPTS:
            # ONE byte-identical resend with the SAME messageId: the frozen
            # idempotency contract returns the ORIGINAL task (§5.3) — never
            # a new task for a retried turn.
            logger.info(
                "[%s] first-response loss: bounded resend (same messageId=%s)", TAG, controller.message_id
            )
            controller.outcome.resend_recovered = True
            request = sdk["SendMessageRequest"](message=message)
            try:
                stream = await turn_client.send_message(request)
            except ProviderTurnError:
                raise
            except Exception as second:
                logger.warning("[%s] resend failed (%s)", TAG, type(second).__name__)
                controller.push_error(
                    ProviderTurnError(REASON_SERVER_UNREACHABLE, "send failed twice at transport level")
                )
                return
            try:
                await self._consume_stream(controller, sdk, turn_client, stream)
            except _StreamLost:
                controller.push_error(
                    ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "stream lost again after resend")
                )
            return
        controller.push_error(
            ProviderTurnError(REASON_SERVER_UNREACHABLE, "send failed at transport level")
        )

    async def _recover_from_stream_loss(
        self,
        controller: _TurnController,
        sdk: Dict[str, Any],
        turn_client: Any,
        lost: _StreamLost,
        message: Any,
        resend_attempts: int,
        resubscribe_attempts: int,
    ) -> str:
        """SSE disconnect recovery. Returns: 'resend' | 'resubscribed' | 'done'.

        GetTask snapshot rebuild FIRST, then — for a still-active task — a
        NEW SubscribeToTask (the #121-safe pattern: no new streaming send
        after an abandoned subscription). No replay of the delivered prefix,
        and never an implicit cancel.
        """
        if controller.consumer_gone.is_set():
            return "done"
        controller.outcome.disconnected = True
        logger.warning(
            "[%s] stream disconnected task=%s (%s); recovery via GetTask snapshot", TAG,
            controller.task_id or "unknown", type(lost.cause).__name__ if lost.cause else "eof",
        )
        if not controller.task_id:
            if lost.cause is not None and self._credential_rejection(lost.cause):
                # 401/403 before any task existed: the credential is the
                # problem — explicit rejection, not a recovery problem.
                raise ProviderTurnError(
                    REASON_CREDENTIAL_REJECTED, "credential rejected by the server"
                ) from lost.cause
            if resend_attempts < MAX_RESEND_ATTEMPTS:
                logger.info(
                    "[%s] first-response loss: bounded resend (same messageId=%s)", TAG, controller.message_id
                )
                return "resend"
            controller.push_error(
                ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "no task id; resend budget exhausted")
            )
            return "done"

        snapshot = await self._snapshot_bounded(controller, sdk, turn_client)
        if snapshot is None:
            controller.push_error(
                ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "GetTask recovery failed")
            )
            return "done"
        state = _state_name(snapshot.status.state)
        controller.outcome.state = state
        self._rebuild_from_snapshot(controller, snapshot)
        if state in TERMINAL_STATES:
            # The execution finished while we were away: the snapshot is the
            # truth; already-delivered text is NOT replayed (§9.3).
            await self._apply_terminal_outcome(controller, snapshot)
            controller.push_end()
            return "done"
        if controller.cancel_requested.is_set():
            # §10.4 补发取消: the intent predates the id — cancel now.
            await self._execute_cancel_and_finish(controller, sdk, turn_client)
            return "done"

        if resubscribe_attempts >= MAX_RESUBSCRIBE_ATTEMPTS:
            controller.push_error(
                ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "resubscribe budget exhausted")
            )
            return "done"
        # P2-04 reconnect gate (issue #116 AC 8): continuing delivery after a
        # disconnect requires a RELIABLE consumption watermark. A damaged or
        # vanished durable ledger means fail-closed — stop the automatic
        # continuation, surface the explicit recovery state, never replay
        # from scratch (TASK_LIFECYCLE §6.2 / A2A_DESIGN §9.3).
        try:
            self._delivery_ledger.verify_integrity(controller.session_id)
        except DeliveryLedgerError as error:
            logger.error(
                "[%s] DELIVERY WATERMARK UNRELIABLE reason=%s task=%s "
                "(explicit recovery state; no automatic replay, no cancel sent)",
                TAG, error.reason, controller.task_id,
            )
            raise ProviderTurnError(
                REASON_DELIVERY_WATERMARK_UNRELIABLE,
                "no reliable consumption watermark; manual/upper-layer recovery required "
                "(no automatic full replay)",
            ) from error
        try:
            sub_stream = await turn_client.subscribe(
                sdk["SubscribeToTaskRequest"](id=controller.task_id)
            )
        except Exception as exc:
            reason = self._wire_error_reason(exc)
            if reason == "terminal_subscription_unsupported":
                # Terminal between the snapshot and the subscribe: the
                # snapshot is the truth (stream-resilience recovery form).
                await self._apply_terminal_outcome(controller, snapshot)
                controller.push_end()
                return "done"
            controller.push_error(
                ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "resubscribe failed ({})".format(reason))
            )
            return "done"
        controller.outcome.resubscribed = True
        logger.info(
            "[%s] resubscribed to task=%s (new subscription; watermark restored from snapshot)", TAG,
            controller.task_id,
        )
        try:
            await self._consume_stream(controller, sdk, turn_client, sub_stream)
        except _StreamLost:
            controller.push_error(
                ProviderTurnError(REASON_RECOVERY_EXHAUSTED, "stream lost again after resubscribe")
            )
        finally:
            aclose = getattr(sub_stream, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:  # pragma: no cover
                    pass
        return "resubscribed"

    def _rebuild_from_snapshot(self, controller: _TurnController, snapshot: Any) -> None:
        for artifact in getattr(snapshot, "artifacts", None) or ():
            artifact_id = getattr(artifact, "artifact_id", "")
            if not artifact_id:
                continue
            aggregated = _text_of_parts(artifact.parts)
            try:
                controller.accumulator.rebuild_from_snapshot(
                    artifact_id=artifact_id,
                    artifact_metadata=_as_mapping(getattr(artifact, "metadata", None)),
                    aggregated_text=aggregated,
                )
            except ContractViolation as violation:
                self._fence_on_violation(controller, violation)
                return
