# P1-11 (issue #111) official Python SDK × REAL a2a-server interop probe.
#
# Drives the STANDALONE LumiThink A2A validation service
# (services/a2a-server/src/main.ts, spawned by tests/python-sdk-interop.spec.ts)
# with the LOCKED official Python client a2a-sdk==1.2.3 (httpx JSON-RPC
# transport) and verifies the seven scenario groups of issue #111 against the
# REAL server (SQLite Task Manager + two-tier identity + idempotent acceptance
# + dispatch lease + Outbox). The official JS baseline lives in
# tests/official-client-roundtrip.spec.ts / acceptance-idempotency.spec.ts /
# stream-resilience.spec.ts / p1-07-cancel-semantics.spec.ts /
# identity-service-acl.spec.ts — every check below mirrors one of those
# anchors so the JS/Python comparison table in
# docs/reviews/2026-10-29-p1-11-python-sdk-interop-verification.md stays
# traceable.
#
# Semantics pinned by the server implementation (NOT invented):
#   - continuation = new message (new messageId) carrying the existing
#     contextId → a NEW task in the SAME context (A2A_DESIGN §9.2 line 307);
#     per-turn supplementary input (appendTurn) is repository-level and NOT
#     wire-reachable, so no INPUT_REQUIRED behavior is asserted;
#   - first-response-loss retry = byte-identical original message (same
#     messageId) → the ORIGINAL task snapshot, no re-execution
#     (acceptance-idempotency AC1/AC2);
#   - the retry as SendStreamingMessage answers with exactly ONE SSE frame
#     carrying the original task (ADR-0015 §5.2 snapshot answer);
#   - SSE disconnect never cancels (R8); recovery = GetTask + resubscribe;
#   - duplicate CancelTask on CANCELED → idempotent success (fixture 09);
#     CancelTask on COMPLETED → -32002 (fixture 08); unknown task → -32001
#     (fixture 11); terminal subscription → -32004 (fixture 10); missing/
#     unsupported A2A-Version → -32009 (fixture 12).
#
# Everything is loopback + synthetic (P1 口径). No real credentials, no real
# child data, no UDS switch. Any failed check exits NON-ZERO — the probe
# never reports success with a failure, and it never silently skips.
#
# Usage:
#   python python_sdk_interop_probe.py --base-url http://127.0.0.1:PORT \
#       --token <credential-A> --token-b <credential-B> \
#       --evidence-out evidence.json [--runtime-label synthetic|dsh-worker]
#
# Requires the official a2a-sdk==1.2.3 importable (pip install, or the
# sha256-verified unpacked tree from P0-02 via PYTHONPATH — see
# docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md §1/§6).
import argparse
import asyncio
import json
import platform
import sys
import time
import traceback
from importlib import metadata

import httpx
from google.protobuf.json_format import MessageToDict

try:
    from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
    from a2a.types import (
        CancelTaskRequest,
        GetTaskRequest,
        ListTasksRequest,
        Message,
        Part,
        Role,
        SendMessageRequest,
        SubscribeToTaskRequest,
        TaskState,
    )
    from a2a.types.a2a_pb2 import Artifact, TaskArtifactUpdateEvent
    from a2a.utils.errors import A2AError, JSON_RPC_ERROR_CODE_MAP
except ImportError as exc:  # pragma: no cover - environment failure path
    sys.stderr.write(
        "FATAL: the official A2A Python SDK is not importable ({exc}).\n"
        "CI installs it with: pip install a2a-sdk==1.2.3\n"
        "Local sandbox runs use the P0-02 verified tree, e.g.\n"
        "  set PYTHONPATH=C:\\CODE\\_a2a-compat-verify\\pylibs\n".format(exc=exc)
    )
    sys.exit(3)

LOCKED_PYTHON_SDK = "a2a-sdk==1.2.3"
LOCKED_JS_SDK = "@a2a-js/sdk@1.3.0"
A2A_VERSION = "1.0"
CHUNK_1 = "你好。"
CHUNK_2 = "我们开始吧。"
FULL_ANSWER = CHUNK_1 + CHUNK_2

EXIT_OK = 0
EXIT_FAILED_CHECKS = 1
EXIT_USAGE = 2
EXIT_SDK_MISSING = 3

# Diagnostic cap: keep the evidence file bounded even with chatty servers.
MAX_HEADER_LOG = 400


def state_name(state):
    """Enum values surface as ints in the upb build; normalize to names."""
    return state if isinstance(state, str) else TaskState.Name(state)


class ProbeFailure(Exception):
    """Raised by require() on the first failed check (fail-fast)."""

    def __init__(self, check_id, group, detail):
        super().__init__("{}/{} failed: {}".format(group, check_id, detail))
        self.check_id = check_id
        self.group = group
        self.detail = detail


class Checker:
    """Records every check; prints a compact live trace."""

    def __init__(self):
        self.checks = []

    def record(self, check_id, group, passed, detail):
        self.checks.append(
            {"id": check_id, "group": group, "pass": bool(passed), "detail": detail}
        )
        print(
            "[{}] {}/{} :: {}".format(
                "PASS" if passed else "FAIL",
                group,
                check_id,
                json.dumps(detail, ensure_ascii=False, default=str)[:400],
            )
        )
        return bool(passed)

    def require(self, check_id, group, passed, detail):
        if not self.record(check_id, group, passed, detail):
            raise ProbeFailure(check_id, group, detail)


def user_message(message_id, text, metadata=None, context_id=""):
    """Builds the official-SDK runtime Message (proto-plus shapes)."""
    kwargs = {}
    if metadata is not None:
        kwargs["metadata"] = metadata
    if context_id:
        kwargs["context_id"] = context_id
    return Message(
        message_id=message_id,
        role=Role.ROLE_USER,
        parts=[Part(text=text)],
        **kwargs,
    )


class HeaderRecorder:
    """httpx request hook: per-request A2A-Version/authorization evidence.

    The locked httpx (0.28.1) awaits request event hooks, so the hook is an
    async callable.
    """

    def __init__(self):
        self.entries = []

    async def __call__(self, request):
        self.entries.append(
            {
                "method": request.method,
                "path": request.url.path,
                "a2aVersion": request.headers.get("A2A-Version"),
                "hasAuthorization": request.headers.get("Authorization") is not None,
            }
        )


class Session:
    """One probe session: official clients for credential A + B, raw client."""

    def __init__(self, base_url, token_a, token_b):
        self.base = base_url.rstrip("/")
        self.token_a = token_a
        self.token_b = token_b
        self.headers_a = HeaderRecorder()
        self.http_a = httpx.AsyncClient(
            timeout=30,
            event_hooks={"request": [self.headers_a]},
            headers={"Authorization": "Bearer {}".format(token_a)},
        )
        self.headers_b = HeaderRecorder()
        self.http_b = httpx.AsyncClient(
            timeout=30,
            event_hooks={"request": [self.headers_b]},
            headers={"Authorization": "Bearer {}".format(token_b)},
        )
        # Plain client: no default A2A-Version/authorization headers — used
        # ONLY for negative wire-shape checks (auth, version).
        self.http_raw = httpx.AsyncClient(timeout=30)

    async def resolve_cards(self):
        factory_a = ClientFactory(ClientConfig(httpx_client=self.http_a))
        factory_b = ClientFactory(ClientConfig(httpx_client=self.http_b))
        resolver_a = A2ACardResolver(httpx_client=self.http_a, base_url=self.base)
        resolver_b = A2ACardResolver(httpx_client=self.http_b, base_url=self.base)
        card_a = await resolver_a.get_agent_card()
        card_b = await resolver_b.get_agent_card()
        self.card = card_a
        # One client per transport mode for credential A: streaming=True uses
        # SendStreamingMessage; streaming=False uses blocking SendMessage.
        self.client_stream_a = factory_a.create(card_a)
        self.client_block_a = ClientFactory(
            ClientConfig(httpx_client=self.http_a, streaming=False)
        ).create(card_a)
        self.client_stream_b = factory_b.create(card_b)
        # Credential B also gets a blocking client for its own acceptance.
        self.client_block_b = ClientFactory(
            ClientConfig(httpx_client=self.http_b, streaming=False)
        ).create(card_b)
        return card_a, card_b

    async def aclose(self):
        for http in (self.http_a, self.http_b, self.http_raw):
            await http.aclose()

    async def raw_rpc(self, method, params, token=None, version=A2A_VERSION):
        """Raw JSON-RPC POST capturing the exact wire body (no SDK wrapping)."""
        headers = {}
        if token is not None:
            headers["Authorization"] = "Bearer {}".format(token)
        if version is not None:
            headers["A2A-Version"] = version
        response = await self.http_raw.post(
            self.base + "/", json={"jsonrpc": "2.0", "id": "raw-1", "method": method, "params": params},
            headers=headers,
        )
        return {"httpStatus": response.status_code, "body": response.json()}

    async def raw_stream_first_frame(self, message_wire, token):
        """Opens a raw SSE stream, reads the FIRST data frame, then CLOSES the
        connection (the explicit transport-level disconnect)."""
        request_body = {
            "jsonrpc": "2.0",
            "id": "raw-stream-1",
            "method": "SendStreamingMessage",
            "params": {"message": message_wire},
        }
        first = None
        async with self.http_raw.stream(
            "POST",
            self.base + "/",
            json=request_body,
            headers={"Authorization": "Bearer {}".format(token), "A2A-Version": A2A_VERSION},
        ) as response:
            buffer = ""
            async for chunk in response.aiter_text():
                buffer += chunk
                while "\n\n" in buffer:
                    block, buffer = buffer.split("\n\n", 1)
                    block = block.strip()
                    if block.startswith("data:"):
                        first = json.loads(block[len("data:"):].strip())
                        break
                if first is not None:
                    break
        return first


def wire_error_reason(body):
    """Extracts the google.rpc.ErrorInfo reason from a raw JSON-RPC body."""
    data = (body.get("error") or {}).get("data")
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and "reason" in entry:
                return entry.get("reason")
    return None


def wire_error_domain(body):
    data = (body.get("error") or {}).get("data")
    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and "domain" in entry:
                return entry.get("domain")
    return None


def error_code_of(exception):
    """Maps a typed A2AError subclass onto its JSON-RPC code (locked SDK)."""
    return JSON_RPC_ERROR_CODE_MAP.get(type(exception))


def task_state_of(task_message):
    return state_name(task_message.status.state)


def artifact_text(task_message):
    parts = []
    for artifact in task_message.artifacts:
        for part in artifact.parts:
            if part.WhichOneof("content") == "text":
                parts.append(part.text)
    return "".join(parts)


async def send_streaming(client, message):
    """Consumes a full streaming send; returns the list of parsed frames."""
    frames = []
    request = SendMessageRequest(message=message)
    async for response in client.send_message(request):
        which = response.WhichOneof("payload")
        payload = getattr(response, which)
        frame = {"oneof": which}
        if which == "task":
            frame["taskId"] = payload.id
            frame["contextId"] = payload.context_id
            frame["state"] = task_state_of(payload)
        elif which == "artifact_update":
            frame["append"] = bool(payload.append)
            frame["lastChunk"] = bool(payload.last_chunk)
            frame["artifactId"] = payload.artifact.artifact_id
        elif which == "status_update":
            frame["state"] = state_name(payload.status.state)
        frames.append(frame)
    return frames


async def send_blocking(client, message):
    """Blocking SendMessage: one StreamResponse (Task or Message oneof)."""
    request = SendMessageRequest(message=message)
    responses = [response async for response in client.send_message(request)]
    if len(responses) != 1:
        raise ProbeFailure("blocking.singleResponse", "messaging", {"count": len(responses)})
    response = responses[0]
    which = response.WhichOneof("payload")
    return which, getattr(response, which)


async def get_task(client, task_id):
    return await client.get_task(GetTaskRequest(id=task_id))


def wire_message(message_id, text, metadata=None, context_id=""):
    """Loose wire shape (mirrors the protocol-error/ACL fixtures) for raw calls."""
    body = {"messageId": message_id, "role": "ROLE_USER", "parts": [{"text": text}]}
    if metadata is not None:
        body["metadata"] = metadata
    if context_id:
        body["contextId"] = context_id
    return body


TERMINAL_STATES = (
    "TASK_STATE_COMPLETED",
    "TASK_STATE_CANCELED",
    "TASK_STATE_FAILED",
    "TASK_STATE_REJECTED",
)


async def observe_disconnect_state(client, task_id, profile):
    """Post-disconnect task-state observation.

    full (parkable synthetic executor): one observation after a settle delay —
    the parked task MUST still be WORKING.
    worker-completion (real dsh-worker executor): workers finish on their own
    (~hundreds of ms), so the executor-invariant under test is "the disconnect
    never CANCELED the task" — poll briefly and assert the task ends WORKING
    or COMPLETED, never CANCELED/FAILED.
    """
    observed = []
    if profile == "full":
        await asyncio.sleep(0.3)
        observed.append(task_state_of(await get_task(client, task_id)))
        return observed
    deadline = time.time() + 3.0
    while True:
        state = task_state_of(await get_task(client, task_id))
        if state not in observed:
            observed.append(state)
        if state in TERMINAL_STATES or time.time() > deadline:
            return observed
        await asyncio.sleep(0.1)


async def park_via_streaming(session, message_id):
    """Streaming send that breaks after the first Task frame (real disconnect)."""
    task_id = ""
    request = SendMessageRequest(
        message=user_message(message_id, "请取消我", metadata={"lumithinkScenario": "cancel-test"})
    )
    async for response in session.client_stream_a.send_message(request):
        if response.WhichOneof("payload") == "task":
            task_id = response.task.id
            break
    return task_id


async def cancel_active_in_window(session, message_id_prefix, checker):
    """Cancel an ACTIVE task → CANCELED (fixtures 13/09).

    The synthetic executor parks forever, so the window is unbounded. The real
    dsh-worker completes in ~hundreds of ms, so the cancel is issued
    immediately after the first Task frame; if that setup window is genuinely
    lost (worker already COMPLETED → -32002), the scenario re-arms with a
    fresh task instead of loosening the assertion. After 3 lost windows the
    check fails.
    """
    last_detail = {}
    for attempt in range(1, 4):
        task_id = await park_via_streaming(session, "{}-{}".format(message_id_prefix, attempt))
        if not task_id:
            checker.require(
                "cancel.activeTaskToCanceled", "cancel", False,
                {"error": "stream never delivered the first Task frame", "attempt": attempt},
            )
        try:
            canceled = await session.client_stream_a.cancel_task(CancelTaskRequest(id=task_id))
            return task_id, task_state_of(canceled), attempt
        except A2AError as err:
            last_detail = {
                "attempt": attempt,
                "exception": type(err).__name__,
                "code": error_code_of(err),
            }
            if error_code_of(err) == -32002:
                continue  # setup window lost (task completed first); re-arm
            raise
    checker.require("cancel.activeTaskToCanceled", "cancel", False, last_detail)


async def run_probe(session, checker, profile, evidence):
    # ------------------------------------------------------------------
    # Phase 0: versions + Agent Card discovery + A2A-Version header (组 1)
    # ------------------------------------------------------------------
    card_a, card_b = await session.resolve_cards()
    evidence["versions"] = {
        "pythonSdk": "{} (imported {})".format(LOCKED_PYTHON_SDK, metadata.version("a2a-sdk")),
        "python": platform.python_version(),
        "jsBaseline": LOCKED_JS_SDK,
        "a2aVersionHeader": A2A_VERSION,
        "agentCardProtocolVersion": card_a.supported_interfaces[0].protocol_version,
        "runtimeLabel": evidence["runtimeLabel"],
    }
    iface = card_a.supported_interfaces[0]
    checker.require(
        "card.discovery",
        "discovery",
        card_a.name == "lumithink"
        and iface.protocol_version == "1.0"
        and iface.protocol_binding == "JSONRPC"
        and bool(card_a.capabilities.streaming)
        and iface.url == session.base
        and card_b.name == "lumithink",
        {
            "name": card_a.name,
            "protocolVersion": iface.protocol_version,
            "protocolBinding": iface.protocol_binding,
            "url": iface.url,
            "streaming": bool(card_a.capabilities.streaming),
            "secondCredentialCardResolved": card_b.name == "lumithink",
        },
    )

    all_headers = session.headers_a.entries + session.headers_b.entries
    versions_seen = sorted({entry["a2aVersion"] for entry in all_headers})
    checker.require(
        "a2aVersion.discoveryRequests",
        "discovery",
        len(all_headers) >= 2 and versions_seen == [A2A_VERSION],
        {
            "requests": len(all_headers),
            "distinctA2AVersionValues": versions_seen,
            "authorizationOnEveryRequest": all(entry["hasAuthorization"] for entry in all_headers),
            "sample": all_headers[:4],
        },
    )
    evidence["a2aVersionHeaders"] = {
        "count": len(all_headers),
        "distinct": versions_seen,
        "entries": all_headers[:MAX_HEADER_LOG],
    }

    # Missing version → treated as 0.3 → -32009 (fixture 12, R7).
    raw = await session.raw_rpc("GetTask", {"id": "task-never"}, token=session.token_a, version=None)
    checker.require(
        "version.missingHeaderRefused",
        "discovery",
        raw["body"].get("error", {}).get("code") == -32009
        and wire_error_reason(raw["body"]) == "VERSION_NOT_SUPPORTED"
        and wire_error_domain(raw["body"]) == "a2a-protocol.org",
        raw["body"],
    )
    # Explicit unsupported version → -32009 as well.
    raw = await session.raw_rpc("GetTask", {"id": "task-never"}, token=session.token_a, version="9.9")
    checker.require(
        "version.unsupported9_9Refused",
        "discovery",
        raw["body"].get("error", {}).get("code") == -32009,
        raw["body"],
    )
    # Unauthenticated request → HTTP 401 + standard reason (no task created —
    # the server-side gate never reaches the ledger).
    raw = await session.raw_rpc("GetTask", {"id": "task-never"}, token=None, version=A2A_VERSION)
    checker.require(
        "auth.unauthenticated401",
        "discovery",
        raw["httpStatus"] == 401
        and raw["body"].get("error", {}).get("code") == -32000
        and wire_error_reason(raw["body"]) == "AUTHENTICATION_REQUIRED",
        {"httpStatus": raw["httpStatus"], "body": raw["body"]},
    )

    # ------------------------------------------------------------------
    # Phase 1: blocking + streaming SendMessage / GetTask / 多轮续接 (组 2)
    # ------------------------------------------------------------------
    which, task = await send_blocking(session.client_block_a, user_message("py-msg-block-1", "你好"))
    checker.require(
        "blocking.taskOnlyCompleted",
        "messaging",
        which == "task"
        and task_state_of(task) == "TASK_STATE_COMPLETED"
        and len(task.artifacts) >= 1,
        {"oneof": which, "state": task_state_of(task), "artifacts": len(task.artifacts)},
    )
    blocking_task_id = task.id

    stream_frames = await send_streaming(session.client_stream_a, user_message("py-msg-stream-1", "你好"))
    kinds = [frame["oneof"] for frame in stream_frames]
    updates = [frame for frame in stream_frames if frame["oneof"] == "artifact_update"]
    artifact_fields = {field.name for field in Artifact.DESCRIPTOR.fields}
    event_fields = {field.name for field in TaskArtifactUpdateEvent.DESCRIPTOR.fields}
    state_names = [name for name, _ in TaskState.items()]
    checker.require(
        "streaming.taskFirstAndChunkOwnership",
        "messaging",
        kinds[0] == "task"
        and kinds[-1] == "status_update"
        and stream_frames[-1]["state"] == "TASK_STATE_COMPLETED"
        and len(updates) == 2
        and updates[0]["append"] is False and updates[0].get("lastChunk") is False
        and updates[1]["append"] is True and updates[1]["lastChunk"] is True
        and "append" not in artifact_fields and "lastChunk" not in artifact_fields
        and "append" in event_fields and "last_chunk" in event_fields
        and "TASK_STATE_CANCELLING" not in state_names,
        {
            "kinds": kinds,
            "updates": updates,
            "artifactFields": sorted(artifact_fields),
            "noCancellingState": "TASK_STATE_CANCELLING" not in state_names,
        },
    )
    streaming_task_id = stream_frames[0]["taskId"]
    streaming_context_id = stream_frames[0]["contextId"]

    snapshot = await get_task(session.client_stream_a, streaming_task_id)
    snapshot_artifact = snapshot.artifacts[0] if snapshot.artifacts else None
    snapshot_wire = MessageToDict(snapshot_artifact) if snapshot_artifact is not None else {}
    checker.require(
        "getTask.snapshotAggregation",
        "messaging",
        task_state_of(snapshot) == "TASK_STATE_COMPLETED"
        and artifact_text(snapshot) == FULL_ANSWER
        and len(snapshot.history) == 1
        and "append" not in snapshot_wire and "lastChunk" not in snapshot_wire,
        {
            "state": task_state_of(snapshot),
            "artifacts": len(snapshot.artifacts),
            "parts": len(snapshot_artifact.parts) if snapshot_artifact else 0,
            "concatenatedText": artifact_text(snapshot),
            "historyEntries": len(snapshot.history),
            "artifactKeys": sorted(snapshot_wire.keys()),
        },
    )

    # 多轮续接 (design §9.2): a NEW messageId with the existing contextId
    # creates a NEW task in the SAME context — never a wire-level error.
    _, continuation = await send_blocking(
        session.client_block_a,
        user_message("py-msg-continue-1", "我们继续", context_id=streaming_context_id),
    )
    checker.require(
        "multiTurn.contextContinuation",
        "messaging",
        continuation.id != streaming_task_id
        and continuation.context_id == streaming_context_id
        and task_state_of(continuation) == "TASK_STATE_COMPLETED",
        {
            "originalTaskId": streaming_task_id,
            "newTaskId": continuation.id,
            "sharedContextId": continuation.context_id,
            "newTaskState": task_state_of(continuation),
        },
    )

    # ------------------------------------------------------------------
    # Phase 2: first-response loss + conflict (组 5)
    # ------------------------------------------------------------------
    original_lost = user_message("py-msg-lost-1", "你好")
    _, _discarded = await send_blocking(session.client_block_a, original_lost)  # response lost
    _, recovered = await send_blocking(session.client_block_a, original_lost)  # byte-identical retry
    checker.require(
        "firstResponseLoss.sameTaskIdRetry",
        "recovery",
        task_state_of(recovered) == "TASK_STATE_COMPLETED" and recovered.id,
        {"recoveredTaskId": recovered.id, "state": task_state_of(recovered)},
    )
    lost_task_id = recovered.id
    duplicate_frames = await send_streaming(session.client_stream_a, original_lost)
    checker.require(
        "firstResponseLoss.streamingDuplicateSingleFrame",
        "recovery",
        len(duplicate_frames) == 1
        and duplicate_frames[0]["oneof"] == "task"
        and duplicate_frames[0]["taskId"] == lost_task_id
        and duplicate_frames[0]["state"] == "TASK_STATE_COMPLETED",
        {"frames": duplicate_frames},
    )
    evidence["artifacts"]["firstResponseLossTaskId"] = lost_task_id

    _, _first = await send_blocking(session.client_block_a, user_message("py-msg-conflict-1", "第一条"))
    conflict_task_id = _first.id
    try:
        await send_blocking(session.client_block_a, user_message("py-msg-conflict-1", "不同的内容"))
        checker.require(
            "conflict.sameKeyDifferentContent", "recovery", False,
            {"error": "the conflicting re-key was accepted (expected -32602)"},
        )
    except A2AError as err:
        checker.require(
            "conflict.sameKeyDifferentContent",
            "recovery",
            error_code_of(err) == -32602 and type(err).__name__ == "InvalidParamsError",
            {"exception": type(err).__name__, "code": error_code_of(err)},
        )
    raw = await session.raw_rpc(
        "SendMessage", {"message": wire_message("py-msg-conflict-1", "第三种变体")},
        token=session.token_a,
    )
    conflict_body = raw["body"]
    conflict_wire = json.dumps(conflict_body, ensure_ascii=False)
    checker.require(
        "conflict.wireReasonAndNoLeak",
        "recovery",
        conflict_body.get("error", {}).get("code") == -32602
        and wire_error_reason(conflict_body) == "MESSAGE_ID_CONFLICT"
        and wire_error_domain(conflict_body) == "lumithink.a2a"
        and conflict_task_id not in conflict_wire
        and "第一条" not in conflict_wire
        and "不同的内容" not in conflict_wire,
        {"body": conflict_body, "leaks": conflict_task_id in conflict_wire},
    )

    # ------------------------------------------------------------------
    # Phase 3: SSE 断开 → 恢复 + 跨主体负例 + 取消语义族 (组 3/4/6)
    # ------------------------------------------------------------------
    # (a) Official client drops the stream after the first Task frame.
    parked_task_id = await park_via_streaming(session, "py-msg-park-1")
    checker.require(
        "stream.parkFirstFrameTask", "streamResilience", bool(parked_task_id),
        {"taskId": parked_task_id, "profile": profile},
    )
    observed_a = await observe_disconnect_state(session.client_stream_a, parked_task_id, profile)
    checker.require(
        "disconnect.officialClientEarlyBreakNotCanceled",
        "streamResilience",
        observed_a[-1] == "TASK_STATE_WORKING"
        if profile == "full"
        else observed_a[-1] in ("TASK_STATE_WORKING", "TASK_STATE_COMPLETED")
        and "TASK_STATE_CANCELED" not in observed_a
        and "TASK_STATE_FAILED" not in observed_a,
        {"profile": profile, "observedStates": observed_a, "taskId": parked_task_id},
    )

    # Cross-principal negatives against credential A's task (credential B):
    # standard TaskNotFound, no subject leakage on the typed surface. These
    # are ACL decisions — independent of the task's lifecycle state.
    for check_id, call in (
        ("identity.crossGetDenied", lambda: get_task(session.client_stream_b, parked_task_id)),
        (
            "identity.crossCancelDenied",
            lambda: session.client_stream_b.cancel_task(CancelTaskRequest(id=parked_task_id)),
        ),
        (
            "identity.crossSubscribeDenied",
            lambda: anext(
                session.client_stream_b.subscribe(SubscribeToTaskRequest(id=parked_task_id)),
                None,
            ),
        ),
    ):
        try:
            await call()
            checker.require(check_id, "identity", False, {"error": "cross-principal access was allowed"})
        except A2AError as err:
            checker.require(
                check_id,
                "identity",
                error_code_of(err) == -32001,
                {"exception": type(err).__name__, "code": error_code_of(err)},
            )

    # (b) Explicit transport-level disconnect via raw SSE, then recovery.
    raw_first = await session.raw_stream_first_frame(
        wire_message(
            "py-msg-park-2", "请取消我", metadata={"lumithinkScenario": "cancel-test"}
        ),
        session.token_a,
    )
    parked_task_id_2 = ((raw_first or {}).get("result") or {}).get("task", {}).get("id", "")
    checker.require(
        "disconnect.rawFirstFrameCarriesTask", "streamResilience",
        bool(parked_task_id_2), {"taskId": parked_task_id_2},
    )
    observed_b = await observe_disconnect_state(session.client_stream_a, parked_task_id_2, profile)
    checker.require(
        "disconnect.explicitCloseNotCanceled",
        "streamResilience",
        observed_b[-1] == "TASK_STATE_WORKING"
        if profile == "full"
        else observed_b[-1] in ("TASK_STATE_WORKING", "TASK_STATE_COMPLETED")
        and "TASK_STATE_CANCELED" not in observed_b
        and "TASK_STATE_FAILED" not in observed_b,
        {"profile": profile, "observedStates": observed_b, "taskId": parked_task_id_2},
    )

    # Resubscribe: on an ACTIVE task the official subscribe re-attaches and
    # the first delivered frame is the Task (JS anchor: stream-resilience
    # 'resubscribe on an ACTIVE task'); on an already-terminal task the same
    # request is the standard -32004 (fixture 10). Both branches are server
    # semantics; the profile only decides which one is reachable.
    resubscribed_first = None
    resubscribed_task_id = ""
    if profile == "full":
        async for response in session.client_stream_a.subscribe(
            SubscribeToTaskRequest(id=parked_task_id_2)
        ):
            resubscribed_first = response.WhichOneof("payload")
            if resubscribed_first == "task":
                resubscribed_task_id = response.task.id
            break
        checker.require(
            "resubscribe.activeTaskDeliversTask",
            "streamResilience",
            resubscribed_first == "task" and resubscribed_task_id == parked_task_id_2,
            {"firstFrame": resubscribed_first, "taskId": resubscribed_task_id},
        )
    else:
        if observed_b[-1] == "TASK_STATE_COMPLETED":
            try:
                async for _event in session.client_stream_a.subscribe(
                    SubscribeToTaskRequest(id=parked_task_id_2)
                ):
                    resubscribed_first = "delivered"
                    break
                checker.require(
                    "resubscribe.terminalTaskRefused",
                    "streamResilience", False,
                    {"error": "terminal task delivered subscription events"},
                )
            except A2AError as err:
                checker.require(
                    "resubscribe.terminalTaskRefused",
                    "streamResilience",
                    error_code_of(err) == -32004,
                    {"exception": type(err).__name__, "code": error_code_of(err)},
                )
        else:
            async for response in session.client_stream_a.subscribe(
                SubscribeToTaskRequest(id=parked_task_id_2)
            ):
                resubscribed_first = response.WhichOneof("payload")
                if resubscribed_first == "task":
                    resubscribed_task_id = response.task.id
                break
            checker.require(
                "resubscribe.activeTaskDeliversTask",
                "streamResilience",
                resubscribed_first == "task" and resubscribed_task_id == parked_task_id_2,
                {"firstFrame": resubscribed_first, "taskId": resubscribed_task_id},
            )

    # (c) Settle the resubscribed task via the ACTIVE-cancel anchor and pin
    # the duplicate-cancel idempotency (fixtures 13/09) + DB anchor.
    #
    # ORDERING NOTE (observed interaction, see the P1-11 review record): an
    # abandoned resubscribe stream on a STILL-ACTIVE task leaves the
    # server-side resubscribe generator attached, and the NEXT new
    # SendStreamingMessage is then refused by the SDK stream-pattern guard
    # ("Received statusUpdate before initial 'Message'/'Task' event.") until
    # the task settles (terminal → bus finished). Settling the resubscribed
    # task here — which IS the cancel-active scenario — restores a clean
    # stream state before any further streaming send. No assertion below is
    # weakened by this ordering.
    if profile == "full":
        # The resubscribed task is still ACTIVE (parked) — settle it via the
        # cancel path and assert the CANCELED result.
        active_cancel_id = parked_task_id_2
        canceled_state = task_state_of(
            await session.client_stream_a.cancel_task(CancelTaskRequest(id=active_cancel_id))
        )
        cancel_attempts = 1
    else:
        # Real dsh-worker: the resubscribed task may already be COMPLETED
        # (workers finish on their own); the windowed re-arming cancel keeps
        # the "cancel on an ACTIVE task → CANCELED" assertion strict.
        active_cancel_id, canceled_state, cancel_attempts = await cancel_active_in_window(
            session, "py-msg-active-cancel", checker
        )
    checker.require(
        "cancel.activeTaskToCanceled",
        "cancel",
        canceled_state == "TASK_STATE_CANCELED",
        {"state": canceled_state, "taskId": active_cancel_id, "attempts": cancel_attempts},
    )
    # Duplicate cancel on the CANCELED task → idempotent SUCCESS (fixture 09).
    canceled_again = await session.client_stream_a.cancel_task(
        CancelTaskRequest(id=active_cancel_id)
    )
    checker.require(
        "cancel.duplicateIdempotentSuccess",
        "cancel",
        task_state_of(canceled_again) == "TASK_STATE_CANCELED",
        {"state": task_state_of(canceled_again), "taskId": active_cancel_id},
    )
    evidence["artifacts"]["duplicateCancelTaskId"] = active_cancel_id

    # Settle every task still parked by this probe (profile-dependent; a
    # completed task refuses with -32002, which is fine for cleanup).
    for cleanup_id in (parked_task_id,):
        try:
            await session.client_stream_a.cancel_task(CancelTaskRequest(id=cleanup_id))
        except A2AError as err:
            if error_code_of(err) != -32002:
                raise

    # CancelTask on a COMPLETED task → -32002 (fixture 08).
    try:
        await session.client_stream_a.cancel_task(CancelTaskRequest(id=blocking_task_id))
        checker.require("cancel.onCompletedTaskNotCancelable", "cancel", False,
                        {"error": "cancel on COMPLETED was accepted"})
    except A2AError as err:
        checker.require(
            "cancel.onCompletedTaskNotCancelable",
            "cancel",
            error_code_of(err) == -32002 and type(err).__name__ == "TaskNotCancelableError",
            {"exception": type(err).__name__, "code": error_code_of(err)},
        )
    raw = await session.raw_rpc("CancelTask", {"id": blocking_task_id}, token=session.token_a)
    checker.require(
        "cancel.onCompletedWireShape",
        "cancel",
        raw["body"].get("error", {}).get("code") == -32002
        and wire_error_reason(raw["body"]) == "TASK_NOT_CANCELABLE"
        and wire_error_domain(raw["body"]) == "a2a-protocol.org",
        raw["body"],
    )

    # Unknown task → -32001 (fixture 11), typed and raw.
    try:
        await session.client_stream_a.cancel_task(CancelTaskRequest(id="task-does-not-exist"))
        checker.require("cancel.unknownTaskNotFound", "cancel", False, {"error": "unknown task cancel was accepted"})
    except A2AError as err:
        checker.require(
            "cancel.unknownTaskNotFound",
            "cancel",
            error_code_of(err) == -32001 and type(err).__name__ == "TaskNotFoundError",
            {"exception": type(err).__name__, "code": error_code_of(err)},
        )
    raw = await session.raw_rpc("GetTask", {"id": "task-does-not-exist"}, token=session.token_a)
    checker.require(
        "getTask.unknownTaskNotFound",
        "cancel",
        raw["body"].get("error", {}).get("code") == -32001
        and wire_error_reason(raw["body"]) == "TASK_NOT_FOUND",
        raw["body"],
    )

    # Terminal subscription → -32004 (fixture 10), typed and raw.
    try:
        async for _event in session.client_stream_a.subscribe(
            SubscribeToTaskRequest(id=streaming_task_id)
        ):
            pass
        checker.require("subscribe.terminalTaskUnsupported", "cancel", False,
                        {"error": "terminal subscription delivered events"})
    except A2AError as err:
        checker.require(
            "subscribe.terminalTaskUnsupported",
            "cancel",
            error_code_of(err) == -32004 and type(err).__name__ == "UnsupportedOperationError",
            {"exception": type(err).__name__, "code": error_code_of(err)},
        )
    raw = await session.raw_rpc("SubscribeToTask", {"id": streaming_task_id}, token=session.token_a)
    checker.require(
        "subscribe.terminalWireShape",
        "cancel",
        raw["body"].get("error", {}).get("code") == -32004,
        raw["body"],
    )

    # ------------------------------------------------------------------
    # Phase 4: identity isolation remainder (组 6)
    # ------------------------------------------------------------------
    # Forged metadata never elevates: the task binds to credential A's real
    # scope, so credential B still cannot read it (client-visible).
    _, forged = await send_blocking(
        session.client_block_a,
        user_message(
            "py-msg-forge-1",
            "你好",
            metadata={"userId": "guardian-b", "householdId": "hh-beta", "tenant": "hh-beta"},
        ),
    )
    forged_task_id = forged.id
    try:
        await get_task(session.client_stream_b, forged_task_id)
        checker.require("identity.forgedMetadataIgnored", "identity", False,
                        {"error": "forged metadata elevated access"})
    except A2AError as err:
        checker.require(
            "identity.forgedMetadataIgnored",
            "identity",
            error_code_of(err) == -32001,
            {"exception": type(err).__name__, "code": error_code_of(err), "taskId": forged_task_id},
        )

    # The same messageId under credential B is a DIFFERENT request key: B gets
    # its own task (no conflict, no visibility into A's task).
    _, b_task = await send_blocking(
        session.client_block_b,
        user_message("py-msg-block-1", "你好"),
    )
    checker.require(
        "identity.crossPrincipalSameMessageIdDistinctKey",
        "identity",
        b_task.id != blocking_task_id and task_state_of(b_task) == "TASK_STATE_COMPLETED",
        {
            "aTaskId": blocking_task_id,
            "bTaskId": b_task.id,
            "bState": task_state_of(b_task),
        },
    )

    # ListTasks scope filtering: none of credential A's task ids appear in
    # credential B's listing.
    listing = await session.client_stream_b.list_tasks(ListTasksRequest())
    listed_ids = [t.id for t in listing.tasks]
    a_task_ids = [
        blocking_task_id,
        streaming_task_id,
        continuation.id,
        parked_task_id,
        parked_task_id_2,
        forged_task_id,
        lost_task_id,
        conflict_task_id,
    ]
    leaked = [task_id for task_id in a_task_ids if task_id in listed_ids]
    checker.require(
        "identity.listTasksFiltered",
        "identity",
        leaked == [],
        {"bListedCount": len(listed_ids), "leakedTaskIds": leaked, "aTaskIdsAtRisk": len(a_task_ids)},
    )

    # ------------------------------------------------------------------
    # Phase 5: full-session per-request A2A-Version header evidence (组 1)
    # ------------------------------------------------------------------
    # Every request the official clients made across ALL scenarios — card
    # discovery, JSON-RPC POSTs, SSE streams — carried A2A-Version: 1.0 with
    # the bearer credential attached (spec §3.6.1 client obligation).
    final_headers = session.headers_a.entries + session.headers_b.entries
    final_versions = sorted({entry["a2aVersion"] for entry in final_headers})
    checker.require(
        "a2aVersion.perRequest",
        "discovery",
        len(final_headers) >= 20
        and final_versions == [A2A_VERSION]
        and all(entry["hasAuthorization"] for entry in final_headers),
        {
            "requests": len(final_headers),
            "distinctA2AVersionValues": final_versions,
            "authorizationOnEveryRequest": True,
            "paths": sorted({entry["path"] for entry in final_headers}),
        },
    )
    evidence["a2aVersionHeaders"] = {
        "count": len(final_headers),
        "distinct": final_versions,
        "entries": final_headers[:MAX_HEADER_LOG],
    }


async def main_async(args):
    checker = Checker()
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    evidence = {
        "probe": "python_sdk_interop_probe",
        "issue": "https://github.com/lybym/LumiThink/issues/111",
        "startedAt": started,
        "runtimeLabel": args.runtime_label,
        "base": args.base_url.rstrip("/"),
        "versions": {},
        "a2aVersionHeaders": {},
        "checks": [],
        "artifacts": {},
        "summary": {"total": 0, "passed": 0, "failed": 0},
    }
    session = Session(args.base_url, args.token, args.token_b)
    try:
        # The B-credential blocking client is created with the other clients.
        # (Defined here so every scenario shares one factory/session.)
        await run_probe(session, checker, args.profile, evidence)
    except ProbeFailure as failure:
        # require() already recorded the failed check before raising; only
        # record here when the failure was raised directly (not via require).
        already_recorded = any(
            check["id"] == failure.check_id and not check["pass"]
            for check in checker.checks
        )
        if not already_recorded:
            checker.record(failure.check_id, failure.group, False, failure.detail)
    except Exception as exc:  # noqa: BLE001 - the probe must report, not crash silently
        traceback.print_exc()
        checker.record(
            "unexpected.exception", "internal", False,
            {"error": repr(exc), "type": type(exc).__name__},
        )
    finally:
        await session.aclose()
    evidence["checks"] = checker.checks
    evidence["summary"] = {
        "total": len(checker.checks),
        "passed": sum(1 for check in checker.checks if check["pass"]),
        "failed": sum(1 for check in checker.checks if not check["pass"]),
    }
    evidence["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload = json.dumps(evidence, ensure_ascii=False, indent=2, default=str)
    if args.evidence_out:
        with open(args.evidence_out, "w", encoding="utf-8") as handle:
            handle.write(payload)
    print(
        "\nPY INTEROP PROBE {}: {}/{} checks passed".format(
            "OK" if evidence["summary"]["failed"] == 0 else "FAILED",
            evidence["summary"]["passed"],
            evidence["summary"]["total"],
        )
    )
    return EXIT_OK if evidence["summary"]["failed"] == 0 else EXIT_FAILED_CHECKS


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # noqa: SLF001 - guard CJK console output
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(
        description=(
            "P1-11 (issue #111) official Python SDK interop probe: drives the real "
            "LumiThink a2a-server with the locked a2a-sdk==1.2.3 official client."
        )
    )
    parser.add_argument("--base-url", required=True, help="e.g. http://127.0.0.1:3312")
    parser.add_argument("--token", required=True, help="primary synthetic bearer credential (A)")
    parser.add_argument("--token-b", required=True, help="second synthetic bearer credential (B)")
    parser.add_argument("--evidence-out", default=None, help="machine-readable evidence JSON path")
    parser.add_argument("--runtime-label", default="synthetic", help="server runtime mode label for evidence")
    parser.add_argument(
        "--profile",
        choices=["full", "worker-completion"],
        default="full",
        help="full: parkable executor, all checks strict; worker-completion: real dsh-worker "
        "executor whose workers complete on their own — disconnect checks assert the "
        "never-canceled invariant and the resubscribe branches on the settled state",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(args))


if __name__ == "__main__":
    sys.exit(main())
