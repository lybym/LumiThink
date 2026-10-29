"""Provider unit tests with injected fake clients (P2-03, issue #115).

Covers the integration-face behavior contract against the locked SDK's
runtime shapes: generator mapping, §7.4 cancel on an independent client,
§10.3 disconnect-never-cancels + GetTask/rebuild/resubscribe recovery,
suppressed-completion presentation, credential fail-closed and token
hygiene. All content synthetic; loopback only.
"""
import asyncio
import logging
import os
import threading
import unittest
from unittest import mock

from a2a.types import (
    Artifact,
    Part,
    StreamResponse,
    Task,
    TaskArtifactUpdateEvent,
    TaskState,
    TaskStatus,
    TaskStatusUpdateEvent,
)

from xiaozhi_a2a_provider.provider import (
    PRESENTATION_CANCELED,
    PRESENTATION_COMPLETE,
    PRESENTATION_COMPLETED_SUPPRESSED,
    PRESENTATION_ERROR,
    ProviderConfigError,
    ProviderTurnError,
    XiaozhiA2AProvider,
)
from xiaozhi_a2a_provider.output_contract import sha256_hex

CHUNK_1 = "你好。"
CHUNK_2 = "我们开始吧。"
FULL_ANSWER = CHUNK_1 + CHUNK_2
ANSWER_META = {"lumithinkContent": {"version": 1, "category": "admitted-answer"}}
SYNTHETIC_TOKEN = "synthetic-xiaozhi-device-token-0123456789"


def output_meta(chunk_id, text, start):
    return {
        "lumithinkOutput": {
            "version": 1,
            "chunkId": chunk_id,
            "startByte": start,
            "endByte": start + len(text.encode("utf-8")),
            "sha256": sha256_hex(text),
        }
    }


def artifact_event(chunk_id, text, start, *, append, last_chunk=False, task_id="task-1"):
    return StreamResponse(
        artifact_update=TaskArtifactUpdateEvent(
            task_id=task_id,
            context_id="cx-1",
            artifact=Artifact(
                artifact_id="answer-example",
                parts=[Part(text=text)],
                metadata=ANSWER_META,
            ),
            append=append,
            last_chunk=last_chunk,
            metadata=output_meta(chunk_id, text, start),
        )
    )


def status_event(state, *, task_id="task-1", metadata=None):
    return StreamResponse(
        status_update=TaskStatusUpdateEvent(
            task_id=task_id,
            context_id="cx-1",
            status=TaskStatus(state=state),
            metadata=metadata,
        )
    )


def task_frame(state=TaskState.TASK_STATE_SUBMITTED, *, task_id="task-1", context_id="cx-1"):
    return StreamResponse(
        task=Task(id=task_id, context_id=context_id, status=TaskStatus(state=state))
    )


def snapshot_task(state, *, artifacts=None, metadata=None, task_id="task-1", context_id="cx-1"):
    return Task(
        id=task_id,
        context_id=context_id,
        status=TaskStatus(state=state),
        artifacts=artifacts or [],
        metadata=metadata,
    )


def answer_artifact(text):
    return Artifact(artifact_id="answer-example", parts=[Part(text=text)], metadata=ANSWER_META)


class FakeStream:
    """An async iterator over scripted payloads (optionally then raising).

    ``gates`` maps payload index → threading.Event that must be set before
    that payload is delivered. ``park_until`` holds the stream OPEN (EOF
    deferred) after the scripted payloads, until the event fires — the
    deterministic form of "the task is still running".
    """

    def __init__(self, payloads, error_at_end=None, gates=None, park_until=None):
        self._payloads = list(payloads)
        self._error_at_end = error_at_end
        self._gates = dict(gates or {})
        self._park_until = park_until
        self._index = 0
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        gate = self._gates.get(self._index)
        if gate is not None:
            await asyncio.get_running_loop().run_in_executor(None, gate.wait, 2.0)
        if self._index >= len(self._payloads):
            if self._park_until is not None:
                await asyncio.get_running_loop().run_in_executor(None, self._park_until.wait, 3.0)
            if self._error_at_end is not None:
                raise self._error_at_end
            raise StopAsyncIteration
        payload = self._payloads[self._index]
        self._index += 1
        return payload

    async def aclose(self):
        self.closed = True


class FakeA2AClient:
    """Duck-typed async client recording every call (no network)."""

    def __init__(self, name="turn"):
        self.name = name
        self.send_scripts = []          # each: (payloads, error_at_end, gates)
        self.get_task_results = []      # each: Task or Exception
        self.subscribe_scripts = []
        self.cancel_results = []        # each: Task or Exception
        self.calls = []
        self.cancel_calls = []
        self.on_cancel = None  # optional callback fired when cancel_task records

    # -- scripting helpers ---------------------------------------------

    def queue_send(self, payloads, error_at_end=None, gates=None, park_until=None):
        self.send_scripts.append((payloads, error_at_end, gates, park_until))

    def queue_get(self, result):
        self.get_task_results.append(result)

    def queue_subscribe(self, payloads, error_at_end=None, gates=None, park_until=None):
        self.subscribe_scripts.append((payloads, error_at_end, gates, park_until))

    def queue_cancel(self, result):
        self.cancel_results.append(result)

    # -- duck-typed client surface --------------------------------------

    async def send_message(self, request):
        self.calls.append(("send_message", request))
        if not self.send_scripts:
            raise AssertionError("unexpected send_message (no script)")
        payloads, error_at_end, gates, park_until = self.send_scripts.pop(0)
        return FakeStream(payloads, error_at_end, gates, park_until)

    async def get_task(self, request):
        self.calls.append(("get_task", request))
        if not self.get_task_results:
            raise AssertionError("unexpected get_task (no script)")
        result = self.get_task_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    async def cancel_task(self, request):
        self.calls.append(("cancel_task", request))
        self.cancel_calls.append(request)
        if self.on_cancel is not None:
            self.on_cancel()
        if not self.cancel_results:
            raise AssertionError("unexpected cancel_task (no script)")
        result = self.cancel_results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    async def subscribe(self, request):
        self.calls.append(("subscribe", request))
        if not self.subscribe_scripts:
            raise AssertionError("unexpected subscribe (no script)")
        payloads, error_at_end, gates, park_until = self.subscribe_scripts.pop(0)
        return FakeStream(payloads, error_at_end, gates, park_until)

    async def aclose(self):
        self.calls.append(("aclose", None))


def make_provider(client, cancel_client=None, **config_overrides):
    config = {"base_url": "http://127.0.0.1:3312", "turn_timeout_s": 10.0}
    config.update(config_overrides)
    return XiaozhiA2AProvider(
        config,
        auth_token=SYNTHETIC_TOKEN,
        client_factory=lambda: client,
        cancel_client_factory=lambda: cancel_client if cancel_client is not None else client,
    )


def happy_script(client):
    client.queue_send([
        task_frame(),
        artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        status_event(TaskState.TASK_STATE_WORKING),
        artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
        status_event(TaskState.TASK_STATE_COMPLETED),
    ])
    client.queue_get(snapshot_task(
        TaskState.TASK_STATE_COMPLETED,
        artifacts=[answer_artifact(FULL_ANSWER)],
        metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}},
    ))


def drain(provider, session_id, dialogue, cancel_check=None):
    texts = []
    for text in provider.response(session_id, dialogue, cancel_check):
        texts.append(text)
    return texts


class TestConfigFailClosed(unittest.TestCase):
    def test_base_url_required(self):
        with self.assertRaises(ProviderConfigError) as caught:
            XiaozhiA2AProvider({}, auth_token=SYNTHETIC_TOKEN)
        self.assertEqual(caught.exception.reason, "base_url_required")

    def test_base_url_scheme_checked(self):
        with self.assertRaises(ProviderConfigError):
            XiaozhiA2AProvider({"base_url": "ftp://x"}, auth_token=SYNTHETIC_TOKEN)

    def test_credential_required_from_env(self):
        env = {k: v for k, v in os.environ.items() if k != "LUMITHINK_XIAOZHI_DEVICE_TOKEN"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ProviderConfigError) as caught:
                XiaozhiA2AProvider({"base_url": "http://127.0.0.1:3312"})
        self.assertEqual(caught.exception.reason, "credential_missing")

    def test_grant_headers_incomplete_rejected(self):
        env = {"LUMI_TEST_GRANT": "g-1"}
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("LUMI_TEST_BINDING", None)
            with self.assertRaises(ProviderConfigError) as caught:
                XiaozhiA2AProvider(
                    {
                        "base_url": "http://127.0.0.1:3312",
                        "session_grant_env": "LUMI_TEST_GRANT",
                        "session_binding_env": "LUMI_TEST_BINDING",
                    },
                    auth_token=SYNTHETIC_TOKEN,
                )
        self.assertEqual(caught.exception.reason, "grant_headers_incomplete")


class TestHappyPath(unittest.TestCase):
    def test_full_turn_yields_new_text_only(self):
        client = FakeA2AClient()
        happy_script(client)
        provider = make_provider(client)
        session_id = "sess-a"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)
        self.assertTrue(outcome.answer_complete)
        self.assertFalse(outcome.output_suppressed_after_cancel)
        self.assertEqual(outcome.delivered_fragments, 2)
        self.assertEqual(outcome.duplicate_fragments, 0)
        self.assertEqual(outcome.delivered_bytes, len(FULL_ANSWER.encode("utf-8")))
        self.assertEqual(outcome.state, "TASK_STATE_COMPLETED")

    def test_duplicate_redelivery_filtered(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=True),  # honest redelivery
            artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(TaskState.TASK_STATE_COMPLETED, artifacts=[answer_artifact(FULL_ANSWER)],
                                       metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}}))
        provider = make_provider(client)
        session_id = "sess-dup"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])
        self.assertEqual(provider.last_outcome(session_id).duplicate_fragments, 1)

    def test_same_id_different_content_fences_playback(self):
        client = FakeA2AClient()
        forged = output_meta("answer#chunk-1", CHUNK_1, 0)
        forged["lumithinkOutput"]["sha256"] = sha256_hex("别的内容")
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            status_event(TaskState.TASK_STATE_WORKING),
            StreamResponse(artifact_update=TaskArtifactUpdateEvent(
                task_id="task-1", context_id="cx-1",
                artifact=Artifact(artifact_id="answer-example", parts=[Part(text="被篡改。")], metadata=ANSWER_META),
                append=True, last_chunk=False, metadata=forged,
            )),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(TaskState.TASK_STATE_COMPLETED))
        provider = make_provider(client)
        session_id = "sess-fence"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])  # tampered fragment never played
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.fenced)
        self.assertIn("same_id_different_content", outcome.contract_reasons)
        self.assertEqual(outcome.error_reason, "output_contract_fence")

    def test_suppressed_completion_presented_without_replay(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(FULL_ANSWER)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": True, "answerComplete": False}},
        ))
        provider = make_provider(client)
        session_id = "sess-supp"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])  # only the admitted prefix; NO replay
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETED_SUPPRESSED)
        self.assertFalse(outcome.answer_complete)
        self.assertTrue(outcome.output_suppressed_after_cancel)


class TestCancel(unittest.TestCase):
    def test_cancel_check_sends_cancel_task_on_independent_client(self):
        turn_client = FakeA2AClient("turn")
        cancel_client = FakeA2AClient("cancel")
        cancel_landed = threading.Event()
        cancel_client.on_cancel = cancel_landed.set

        # The stream stays OPEN (parked) until the cancel lands: the tick
        # branch observes the interrupt without any further scripted event.
        turn_client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=cancel_landed)
        cancel_client.queue_cancel(snapshot_task(
            TaskState.TASK_STATE_CANCELED,
            artifacts=[answer_artifact(CHUNK_1)],
            task_id="task-1",
        ))
        provider = make_provider(turn_client, cancel_client)
        session_id = "sess-cancel"
        provider.lumi_on_hello(session_id)

        texts = []

        def cancel_check():
            return bool(texts)  # the interrupt lands right after the first chunk

        texts = []
        gen = provider.response(session_id, [{"role": "user", "content": "你好"}], cancel_check)
        for text in gen:
            texts.append(text)  # the cancel_check flips after the first chunk
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
        self.assertTrue(outcome.cancel_requested)
        self.assertTrue(outcome.cancel_confirmed)
        self.assertEqual(len(cancel_client.cancel_calls), 1)
        self.assertEqual(cancel_client.cancel_calls[0].id, "task-1")
        # The turn stream client NEVER issued the cancel (independent §7.4 context).
        self.assertEqual(turn_client.cancel_calls, [])

    def test_abort_hook_cancels_active_turn(self):
        turn_client = FakeA2AClient()
        cancel_client = FakeA2AClient("cancel")
        cancel_landed = threading.Event()
        cancel_client.on_cancel = cancel_landed.set

        turn_client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=cancel_landed)
        cancel_client.queue_cancel(snapshot_task(TaskState.TASK_STATE_CANCELED, task_id="task-1"))
        provider = make_provider(turn_client, cancel_client)
        session_id = "sess-abort"
        provider.lumi_on_hello(session_id)

        texts = []
        gen = provider.response(session_id, [{"role": "user", "content": "你好"}])
        for text in gen:
            texts.append(text)
            signal = provider.lumi_on_abort(session_id)
            self.assertEqual(signal["status"], "cancel_intent_recorded")
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
        self.assertEqual(len(cancel_client.cancel_calls), 1)

    def test_cancel_on_already_terminal_task_reports_true_state(self):
        turn_client = FakeA2AClient()
        cancel_client = FakeA2AClient("cancel")
        from a2a.utils.errors import TaskNotCancelableError

        turn_client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            status_event(TaskState.TASK_STATE_WORKING),
        ])
        turn_client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(FULL_ANSWER)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}},
        ))
        cancel_client.queue_cancel(TaskNotCancelableError("task not cancelable"))
        provider = make_provider(turn_client, cancel_client)
        session_id = "sess-race"
        provider.lumi_on_hello(session_id)
        texts = []
        gen = provider.response(session_id, [{"role": "user", "content": "你好"}],
                                lambda: bool(texts))  # interrupt after the first chunk
        for text in gen:
            texts.append(text)
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.state, "TASK_STATE_COMPLETED")
        self.assertFalse(outcome.cancel_confirmed)  # never a fabricated cancel
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)

    def test_cancel_without_task_id_recovers_then_cancels(self):
        # Interrupt BEFORE the task frame arrives: the provider keeps
        # consuming until the id is known, then cancels (§10.4 补发取消).
        turn_client = FakeA2AClient()
        cancel_client = FakeA2AClient("cancel")
        flip = threading.Event()

        turn_client.queue_send([task_frame()], gates={0: flip})
        turn_client.queue_send([
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        turn_client.queue_get(snapshot_task(TaskState.TASK_STATE_COMPLETED))
        cancel_client.queue_cancel(snapshot_task(TaskState.TASK_STATE_CANCELED, task_id="task-1"))
        provider = make_provider(turn_client, cancel_client)
        session_id = "sess-early"
        provider.lumi_on_hello(session_id)

        texts = []

        def cancel_check():
            flip.set()  # the interrupt fires while the first frame is still gated
            return True

        for text in provider.response(session_id, [{"role": "user", "content": "你好"}], cancel_check):
            texts.append(text)
        self.assertEqual(texts, [])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
        self.assertEqual(len(cancel_client.cancel_calls), 1)
        self.assertEqual(cancel_client.cancel_calls[0].id, "task-1")


class TestDisconnectRecovery(unittest.TestCase):
    def test_disconnect_never_cancels_and_resubscribes_without_replay(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], error_at_end=ConnectionError("synthetic sse drop"))
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_WORKING,
            artifacts=[answer_artifact(CHUNK_1)],  # snapshot = delivered prefix
        ))
        client.queue_subscribe([
            artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(FULL_ANSWER)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}},
        ))
        provider = make_provider(client)
        session_id = "sess-drop"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])  # no replayed prefix, tail delivered once
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.disconnected)
        self.assertTrue(outcome.resubscribed)
        self.assertFalse(outcome.cancel_requested)
        self.assertEqual(len(client.cancel_calls), 0)
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)

    def test_terminal_snapshot_after_disconnect_delivers_no_new_text(self):
        # §9.3: a queried snapshot rebuilds the consumption position — it is
        # NEVER new voice increments; the tail is recorded as undelivered.
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], error_at_end=ConnectionError("synthetic sse drop"))
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(FULL_ANSWER)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}},
        ))
        provider = make_provider(client)
        session_id = "sess-snap"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.disconnected)
        self.assertFalse(outcome.resubscribed)
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)
        self.assertEqual(len(client.cancel_calls), 0)

    def test_second_stream_loss_ends_with_explicit_recovery_error(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], error_at_end=ConnectionError("drop 1"))
        client.queue_get(snapshot_task(TaskState.TASK_STATE_WORKING, artifacts=[answer_artifact(CHUNK_1)]))
        client.queue_subscribe([
            artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
        ], error_at_end=ConnectionError("drop 2"))
        provider = make_provider(client)
        session_id = "sess-drop2"
        provider.lumi_on_hello(session_id)
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(caught.exception.reason, "recovery_exhausted")

    def test_first_response_loss_recovers_via_identical_resend(self):
        client = FakeA2AClient()
        client.queue_send([], error_at_end=ConnectionError("lost before first frame"))
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(FULL_ANSWER)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}},
        ))
        provider = make_provider(client)
        session_id = "sess-lost"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])
        first_request = client.calls[0][1]
        second_request = next(req for kind, req in client.calls if kind == "send_message")
        self.assertEqual(
            first_request.message.message_id, second_request.message.message_id,
            "the §5.3 retry must be byte-identical (same messageId)",
        )
        self.assertTrue(provider.last_outcome(session_id).resend_recovered)


class TestTurnGuards(unittest.TestCase):
    def test_unregistered_session_rejected_before_any_call(self):
        client = FakeA2AClient()
        provider = make_provider(client)
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, "ghost", [{"role": "user", "content": "你好"}])
        self.assertEqual(caught.exception.reason, "session_not_registered")
        self.assertEqual(client.calls, [])

    def test_empty_and_oversized_prompts_rejected(self):
        client = FakeA2AClient()
        provider = make_provider(client)
        session_id = "sess-guard"
        provider.lumi_on_hello(session_id)
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, session_id, [{"role": "assistant", "content": "hi"}])
        self.assertEqual(caught.exception.reason, "empty_prompt")
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, session_id, [{"role": "user", "content": "x" * 600}])
        self.assertEqual(caught.exception.reason, "prompt_too_long")
        self.assertEqual(client.calls, [])

    def test_turn_timeout_never_cancels(self):
        client = FakeA2AClient()
        hang = threading.Event()  # stays set only after the assertion
        client.queue_send([task_frame()], gates={0: hang})
        provider = make_provider(client, turn_timeout_s=0.6)
        session_id = "sess-timeout"
        provider.lumi_on_hello(session_id)
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(caught.exception.reason, "turn_timeout")
        self.assertEqual(len(client.cancel_calls), 0)
        outcome = provider.last_outcome(session_id)
        self.assertFalse(outcome.cancel_requested)
        hang.set()

    def test_device_closed_stops_playback_without_cancel(self):
        # §10.3: the device going away is NOT a cancel intent — local
        # playback bookkeeping stops, the turn worker detaches quietly, and
        # the server-side execution keeps its own deadline.
        client = FakeA2AClient()
        parked = threading.Event()  # the scripted stream stays open (task active)
        client.queue_send([
            task_frame(TaskState.TASK_STATE_WORKING),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=parked)
        provider = make_provider(client)
        session_id = "sess-closed"
        provider.lumi_on_hello(session_id)
        texts = []
        gen = provider.response(session_id, [{"role": "user", "content": "你好"}])
        for text in gen:
            texts.append(text)
            provider.lumi_on_device_closed(session_id)  # device drops mid-turn
        parked.set()  # release the parked stream fixture after the turn ended

        self.assertEqual(texts, [CHUNK_1])  # playback stopped at the drop
        outcome = provider.last_outcome(session_id)
        # Honest delivery-uncertain presentation: no terminal state was ever
        # observed, no error fabricated, NO cancel sent.
        self.assertEqual(outcome.presentation, PRESENTATION_ERROR)
        self.assertIsNone(outcome.error_reason)
        self.assertEqual(outcome.state, "TASK_STATE_WORKING")
        self.assertFalse(outcome.cancel_requested)
        self.assertEqual(len(client.cancel_calls), 0)
        # Resource cleanup: the turn client was closed (stream detached).
        self.assertIn(("aclose", None), client.calls)

    def test_device_closed_unregisters_session_and_is_idempotent(self):
        client = FakeA2AClient()
        provider = make_provider(client)
        session_id = "sess-closed-reg"
        provider.lumi_on_hello(session_id)
        provider.lumi_on_device_closed(session_id)
        provider.lumi_on_device_closed(session_id)  # second close: harmless no-op
        # The hello gate is gone: a new turn fails closed until re-hello.
        with self.assertRaises(ProviderTurnError) as caught:
            drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(caught.exception.reason, "session_not_registered")
        self.assertEqual(client.calls, [])

    def test_context_continuation_uses_new_message_id_same_context(self):
        client = FakeA2AClient()
        happy_script(client)
        provider = make_provider(client)
        session_id = "sess-ctx"
        provider.lumi_on_hello(session_id)
        drain(provider, session_id, [{"role": "user", "content": "第一轮"}])
        happy_script(client)
        drain(provider, session_id, [{"role": "user", "content": "第二轮"}])
        sends = [req for kind, req in client.calls if kind == "send_message"]
        self.assertEqual(len(sends), 2)
        self.assertNotEqual(sends[0].message.message_id, sends[1].message.message_id)
        self.assertEqual(sends[1].message.context_id, "cx-1")

    def test_token_never_reaches_logs(self):
        records = []

        class Capture(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = Capture()
        logger = logging.getLogger("xiaozhi_a2a_provider")
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
        try:
            client = FakeA2AClient()
            happy_script(client)
            provider = make_provider(client)
            session_id = "sess-token"
            provider.lumi_on_hello(session_id)
            drain(provider, session_id, [{"role": "user", "content": "你好"}])
        finally:
            logger.removeHandler(handler)
        joined = "\n".join(records)
        self.assertNotIn(SYNTHETIC_TOKEN, joined)
        # And the exception surface never carries it either:
        try:
            XiaozhiA2AProvider({"base_url": "http://127.0.0.1:3312"})
        except ProviderConfigError as error:
            self.assertNotIn(SYNTHETIC_TOKEN, str(error))

    def test_auth_headers_carry_credential_for_official_path(self):
        provider = XiaozhiA2AProvider(
            {"base_url": "http://127.0.0.1:3312"}, auth_token=SYNTHETIC_TOKEN
        )
        headers = provider._auth_headers()
        self.assertEqual(headers["Authorization"], "Bearer {}".format(SYNTHETIC_TOKEN))


if __name__ == "__main__":
    unittest.main()
