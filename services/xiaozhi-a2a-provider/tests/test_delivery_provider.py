"""Provider × delivery-watermark integration tests (P2-04, issue #116).

Drives the provider's integration face with injected fake clients (same
methodology as test_provider_unit) and asserts the channel-delivery layer:
the local stop-playback marker on abort, late-fragment filtering, the
final delivery gate (stale generation / ledger duplicates), the reconnect
fail-closed gate on a damaged durable ledger, the read-only Task-state
observation, and the P2-05 settlement-frame drop accounting.
"""
import asyncio
import json
import os
import queue
import tempfile
import threading
import time
import unittest
from unittest import mock

from xiaozhi_a2a_provider import provider as provider_module
from xiaozhi_a2a_provider.delivery_ledger import (
    DELIVERY_STATE_PARTIAL_STOPPED,
    DELIVERY_STATE_UNCERTAIN,
    DeliveryLedgerError,
    MemoryDeliveryLedger,
)
from xiaozhi_a2a_provider.output_contract import sha256_hex
from xiaozhi_a2a_provider.provider import (
    PRESENTATION_CANCELED,
    PRESENTATION_COMPLETE,
    PRESENTATION_COMPLETED_SUPPRESSED,
    ProviderTurnError,
    XiaozhiA2AProvider,
    _DeliveredFragment,
    _TurnController,
)
from a2a.types import TaskState

from tests.test_provider_unit import (
    CHUNK_1,
    CHUNK_2,
    FULL_ANSWER,
    FakeA2AClient,
    answer_artifact,
    artifact_event,
    drain,
    happy_script,
    make_provider,
    snapshot_task,
    status_event,
    task_frame,
)


def file_ledger(directory=None):
    directory = directory or tempfile.mkdtemp(prefix="xz-delivery-")
    return os.path.join(directory, "delivery-ledger.json")


class TestAbortStopMarker(unittest.TestCase):
    def test_abort_sets_local_stop_marker_and_persists_stop(self):
        turn_client = FakeA2AClient()
        cancel_client = FakeA2AClient("cancel")
        cancel_landed = threading.Event()
        cancel_client.on_cancel = cancel_landed.set
        turn_client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=cancel_landed)
        cancel_client.queue_cancel(snapshot_task(TaskState.TASK_STATE_CANCELED, task_id="task-1"))
        ledger_path = file_ledger()
        provider = make_provider(turn_client, cancel_client, delivery_ledger_path=ledger_path)
        session_id = "sess-p204-abort"
        provider.lumi_on_hello(session_id)

        texts = []
        for text in provider.response(session_id, [{"role": "user", "content": "你好"}]):
            texts.append(text)
            signal = provider.lumi_on_abort(session_id)
            # 本地立即止播标记: abort FIRST records the local stop (§10.3 step 1)…
            self.assertTrue(signal["playbackStopped"])
            outcome = provider.last_outcome(session_id)
            self.assertTrue(outcome.delivery_stopped)
            self.assertEqual(outcome.delivery_stop_reason, "device_abort")
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
        self.assertTrue(outcome.delivery_stopped)
        # …and the CancelTask still ran on the independent client (§7.4).
        self.assertEqual(len(cancel_client.cancel_calls), 1)
        self.assertEqual(turn_client.cancel_calls, [])
        # Durable stop evidence in the watermark ledger (content-free).
        summary = provider.delivery_summary(session_id)
        self.assertTrue(summary["stopped"])
        self.assertEqual(summary["stopReason"], "device_abort")
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_PARTIAL_STOPPED)
        self.assertEqual(summary["deliveredFragments"], 1)
        self.assertEqual(summary["deliveredBytes"], len(CHUNK_1.encode("utf-8")))
        # Task observation stays a READ-ONLY observation next to delivery.
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_CANCELED")
        # The ledger file holds the ids/ranges — never the answer text.
        with open(ledger_path, "rb") as handle:
            self.assertTrue(handle.read().decode("utf-8").isascii())

    def test_late_fragment_after_stop_is_filtered_and_recorded(self):
        # White-box deterministic drive: a fragment PROCESSED after the local
        # stop marker must be counted + durably recorded, never played.
        provider = make_provider(FakeA2AClient())
        session_id = "sess-p204-late"
        provider.lumi_on_hello(session_id)
        controller = _TurnController(session_id, "m-1", "你好", time.monotonic() + 30)
        controller.task_id = "task-1"
        controller.generation = provider._delivery_ledger.begin_turn(session_id)
        controller.accumulator.task_id = "task-1"
        sdk = provider._load_sdk()
        event = artifact_event("answer#chunk-2", CHUNK_2, 0, append=False)
        controller.stop_playback("device_abort")
        asyncio.run(provider._handle_payload(controller, sdk, None, event))
        self.assertEqual(controller.outcome.filtered_after_stop_fragments, 1)
        self.assertEqual(controller.queue.qsize(), 0)  # nothing was handed over
        summary = provider.delivery_summary(session_id)
        self.assertEqual(summary["filteredAfterStop"], 1)
        self.assertEqual(summary["deliveredFragments"], 0)
        # The late fragment is NOT in the watermark.
        self.assertNotIn("answer-example/answer#chunk-2", summary["fragments"])

    def test_fenced_turn_counts_late_valid_fragments_as_filtered(self):
        # Same filter branch, deterministic via the §9.3 fence: after the
        # contract violation the stream keeps consuming silently to terminal;
        # the next VALID fragment is filtered (never played after a fence).
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            artifact_event("answer#chunk-1", CHUNK_2, 0, append=False),  # same id, different content
            artifact_event("answer#chunk-2", CHUNK_2, 9, append=True, last_chunk=True),
            status_event(TaskState.TASK_STATE_COMPLETED),
        ])
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_COMPLETED,
            artifacts=[answer_artifact(CHUNK_1 + CHUNK_2)],
            metadata={"lumithinkResult": {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": False}},
        ))
        provider = make_provider(client)
        session_id = "sess-p204-fence-filter"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.fenced)
        self.assertEqual(outcome.filtered_after_stop_fragments, 1)
        self.assertEqual(outcome.delivered_fragments, 1)


class TestDeliveryGate(unittest.TestCase):
    def _controller(self, provider, session_id="sess-gate"):
        controller = _TurnController(session_id, "m-1", "你好", time.monotonic() + 30)
        controller.task_id = "task-1"
        controller.generation = provider._delivery_ledger.begin_turn(session_id)
        controller.accumulator.task_id = "task-1"
        return controller

    def test_gate_records_and_counts_delivery(self):
        provider = make_provider(FakeA2AClient())
        controller = self._controller(provider, "sess-gate-rec")
        meta = _DeliveredFragment("answer-example", "answer#chunk-1", 0, 9, sha256_hex(CHUNK_1))
        self.assertTrue(provider._gate_channel_delivery(controller, meta))
        self.assertEqual(controller.outcome.delivered_fragments, 1)
        self.assertEqual(controller.outcome.delivered_bytes, 9)
        summary = provider.delivery_summary("sess-gate-rec")
        self.assertEqual(summary["fragments"]["answer-example/answer#chunk-1"]["endByte"], 9)

    def test_gate_blocks_stale_generation_fragments(self):
        provider = make_provider(FakeA2AClient())
        session_id = "sess-gate-stale"
        controller = self._controller(provider, session_id)  # gen 1, task-1
        old_generation = controller.generation
        # A NEW turn started meanwhile → the old controller's generation is stale.
        provider._delivery_ledger.begin_turn(session_id)
        controller.task_id = "task-old"
        late_old = _DeliveredFragment("answer-example", "answer#chunk-late", 0, 9, sha256_hex(CHUNK_1))
        self.assertFalse(provider._gate_channel_delivery(controller, late_old))
        self.assertEqual(controller.outcome.stale_generation_fragments, 1)
        self.assertEqual(controller.outcome.delivered_fragments, 0)
        summary = provider.delivery_summary(session_id)
        # No current-generation delivery has been recorded at all — the
        # summary is "unknown" (missing), and the late fragment is nowhere.
        if summary is not None:
            self.assertNotIn("answer-example/answer#chunk-late", summary.get("fragments", {}))
        self.assertEqual(controller.outcome.delivered_fragments, 0)

    def test_gate_blocks_ledger_duplicates(self):
        provider = make_provider(FakeA2AClient())
        controller = self._controller(provider, "sess-gate-dup")
        meta = _DeliveredFragment("answer-example", "answer#chunk-1", 0, 9, sha256_hex(CHUNK_1))
        self.assertTrue(provider._gate_channel_delivery(controller, meta))
        self.assertFalse(provider._gate_channel_delivery(controller, meta))  # second handover
        self.assertEqual(controller.outcome.delivered_fragments, 1)
        self.assertEqual(controller.outcome.duplicate_fragments, 1)

    def test_ledger_write_failure_keeps_delivery_and_counts(self):
        class _FlakyLedger(MemoryDeliveryLedger):
            """Fails every flush AFTER the first (begin_turn lands; records don't)."""

            def __init__(self):
                super().__init__()
                self.calls = 0

            def _flush(self):
                self.calls += 1
                if self.calls > 1:
                    raise DeliveryLedgerError("ledger_unwritable", "synthetic disk failure")

        client = FakeA2AClient()
        happy_script(client)
        provider = make_provider(client)
        provider._delivery_ledger = _FlakyLedger()
        session_id = "sess-gate-broken"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        # §9.3-validated text still reaches the consumer (cannot un-deliver)…
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])
        outcome = provider.last_outcome(session_id)
        # …but the uncertainty is counted honestly (§10.2 交付不确定).
        self.assertGreaterEqual(outcome.watermark_write_failures, 2)


class TestReconnectGate(unittest.TestCase):
    def test_reconnect_with_healthy_ledger_resubscribes_and_dedups(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], error_at_end=ConnectionError("synthetic sse drop"))
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_WORKING,
            artifacts=[answer_artifact(CHUNK_1)],
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
        provider = make_provider(client, delivery_ledger_path=file_ledger())
        session_id = "sess-p204-reconnect"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1, CHUNK_2])  # no replayed prefix, tail once
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.disconnected)
        self.assertTrue(outcome.resubscribed)
        self.assertEqual(len(client.cancel_calls), 0)  # reconnect never cancels
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)
        self.assertEqual(outcome.generation, 1)
        summary = provider.delivery_summary(session_id)
        self.assertEqual(summary["deliveredFragments"], 2)
        self.assertEqual(summary["deliveryState"], "complete")
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_COMPLETED")
        self.assertTrue(summary["answerCompleteObserved"])
        # 水位与 Task 状态分离记录（AC 4）：the ledger stores the delivered
        # ranges under the stable ids — the task observation is a read-only
        # field, the task row on the server stays the only authority.
        with open(provider._delivery_ledger._path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
        turn = doc["sessions"][session_id]["turns"]["1@task-1"]
        self.assertEqual(turn["artifactWatermarks"]["answer-example"], 27)  # 9 + 18 UTF-8 bytes
        self.assertEqual(turn["taskStateObserved"], "TASK_STATE_COMPLETED")

    def test_reconnect_with_damaged_ledger_fails_closed_without_replay(self):
        client = FakeA2AClient()
        release = threading.Event()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=release)
        client.queue_get(snapshot_task(
            TaskState.TASK_STATE_WORKING,
            artifacts=[answer_artifact(CHUNK_1)],
        ))
        ledger_path = file_ledger()
        provider = make_provider(client, delivery_ledger_path=ledger_path)
        session_id = "sess-p204-damaged"
        provider.lumi_on_hello(session_id)
        texts = []
        with self.assertRaises(ProviderTurnError) as caught:
            for text in provider.response(session_id, [{"role": "user", "content": "你好"}]):
                texts.append(text)
                # The durable watermark is damaged WHILE the turn is live.
                with open(ledger_path, "w", encoding="utf-8") as handle:
                    handle.write("externally-corrupted-ledger")
                release.set()  # the SSE stream now "drops"
        self.assertEqual(texts, [CHUNK_1])  # the delivered prefix was NEVER replayed
        self.assertEqual(caught.exception.reason, "delivery_watermark_unreliable")
        outcome = provider.last_outcome(session_id)
        self.assertTrue(outcome.disconnected)
        self.assertEqual(len(client.cancel_calls), 0)  # recovery failure never cancels
        self.assertIsNone(outcome.cancel_confirmed)

    def test_reconnect_gate_skipped_when_consumer_gone(self):
        # 断流不取消的边界保持：consumer 已离开（device_closed）时恢复路径
        # 直接返回，不再触碰账本门控，也绝不发取消。
        client = FakeA2AClient()
        closed = threading.Event()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
        ], park_until=closed)
        provider = make_provider(client, delivery_ledger_path=file_ledger())
        session_id = "sess-p204-gone"
        provider.lumi_on_hello(session_id)
        gen = provider.response(session_id, [{"role": "user", "content": "你好"}])
        next(gen)  # first chunk delivered
        provider.lumi_on_device_closed(session_id)
        closed.set()  # the SSE stream now "drops"
        with self.assertRaises(StopIteration):
            next(gen)
        self.assertEqual(len(client.cancel_calls), 0)
        self.assertEqual(client.get_task_results, [])  # no snapshot was even attempted


class TestGenerationsAcrossTurns(unittest.TestCase):
    def test_each_turn_bumps_the_delivery_generation(self):
        ledger_path = file_ledger()
        client = FakeA2AClient()
        happy_script(client)
        happy_script(client)  # second turn script
        provider = make_provider(client, delivery_ledger_path=ledger_path)
        session_id = "sess-p204-generations"
        provider.lumi_on_hello(session_id)
        texts1 = drain(provider, session_id, [{"role": "user", "content": "第一轮"}])
        self.assertEqual(texts1, [CHUNK_1, CHUNK_2])
        outcome1 = provider.last_outcome(session_id)
        self.assertEqual(outcome1.generation, 1)
        texts2 = drain(provider, session_id, [{"role": "user", "content": "第二轮"}])
        self.assertEqual(texts2, [CHUNK_1, CHUNK_2])
        outcome2 = provider.last_outcome(session_id)
        self.assertEqual(outcome2.generation, 2)
        summary = provider.delivery_summary(session_id)
        self.assertEqual(summary["generation"], 2)  # the LATEST turn
        self.assertFalse(summary["superseded"])
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_COMPLETED")
        # the previous turn's record stays in the ledger, superseded
        with open(ledger_path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
        turns = doc["sessions"][session_id]["turns"]
        self.assertEqual(len(turns), 2)
        old_turn = next(t for t in turns.values() if t["generation"] == 1)
        self.assertTrue(old_turn["superseded"])


class TestSuppressedObservation(unittest.TestCase):
    def test_suppressed_completion_recorded_without_replay(self):
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
        session_id = "sess-p204-suppressed"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])  # only the admitted prefix; NO replay
        outcome = provider.last_outcome(session_id)
        self.assertEqual(outcome.presentation, PRESENTATION_COMPLETED_SUPPRESSED)
        summary = provider.delivery_summary(session_id)
        # 播放完成 ≠ Task 完成：observation and delivery are SEPARATE fields.
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_COMPLETED")
        self.assertFalse(summary["answerCompleteObserved"])
        self.assertTrue(summary["outputSuppressedAfterCancelObserved"])
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_PARTIAL_STOPPED)
        self.assertEqual(summary["deliveredFragments"], 1)

    def test_failed_task_leaves_delivery_uncertain_not_failed_task_rewrite(self):
        client = FakeA2AClient()
        client.queue_send([
            task_frame(),
            artifact_event("answer#chunk-1", CHUNK_1, 0, append=False),
            status_event(TaskState.TASK_STATE_FAILED),
        ])
        client.queue_get(snapshot_task(TaskState.TASK_STATE_FAILED))
        provider = make_provider(client)
        session_id = "sess-p204-failed"
        provider.lumi_on_hello(session_id)
        texts = drain(provider, session_id, [{"role": "user", "content": "你好"}])
        self.assertEqual(texts, [CHUNK_1])
        summary = provider.delivery_summary(session_id)
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_FAILED")
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_UNCERTAIN)


class TestLedgerWiring(unittest.TestCase):
    def test_corrupt_ledger_fails_provider_construction(self):
        path = file_ledger()
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{corrupt")
        with self.assertRaises(Exception) as caught:
            make_provider(FakeA2AClient(), delivery_ledger_path=path)
        self.assertIn("delivery_ledger_unusable", str(caught.exception))

    def test_invalid_ledger_path_rejected(self):
        with self.assertRaises(Exception) as caught:
            make_provider(FakeA2AClient(), delivery_ledger_path="  ")
        self.assertIn("delivery_ledger_path_invalid", str(caught.exception))

    def test_summary_unknown_session_is_none(self):
        provider = make_provider(FakeA2AClient())
        provider.lumi_on_hello("sess-unknown")
        self.assertIsNone(provider.delivery_summary("sess-unknown"))


class TestSettlementFrameDrops(unittest.TestCase):
    """P2-03 review P2-⑤: push_end/push_error 队列满不再静默丢弃。"""

    def _stuffed_controller(self):
        controller = _TurnController("sess-drops", "m-1", "你好", time.monotonic() + 30)
        while True:
            try:
                controller.queue.put_nowait(("text", "x", None))
            except queue.Full:
                return controller

    def test_push_end_drop_is_counted_and_logged(self):
        controller = self._stuffed_controller()
        with mock.patch.object(provider_module, "CRITICAL_PUSH_RETRY_S", 0.2):
            with self.assertLogs("xiaozhi_a2a_provider", level="ERROR") as logs:
                controller.push_end()
        self.assertEqual(controller.outcome.queue_full_drops, 1)
        self.assertTrue(any("settlement frame dropped" in line for line in logs.output))

    def test_push_error_drop_is_counted_and_logged(self):
        controller = self._stuffed_controller()
        with mock.patch.object(provider_module, "CRITICAL_PUSH_RETRY_S", 0.2):
            with self.assertLogs("xiaozhi_a2a_provider", level="ERROR") as logs:
                controller.push_error(ProviderTurnError("server_error", "synthetic"))
        self.assertEqual(controller.outcome.queue_full_drops, 1)
        self.assertEqual(controller.outcome.error_reason, "server_error")
        self.assertTrue(any("settlement frame dropped" in line for line in logs.output))

    def test_push_end_succeeds_when_consumer_drains(self):
        controller = _TurnController("sess-drain", "m-1", "你好", time.monotonic() + 30)
        with mock.patch.object(provider_module, "CRITICAL_PUSH_RETRY_S", 0.2):
            controller.push_end()
        self.assertEqual(controller.outcome.queue_full_drops, 0)
        kind, payload, meta = controller.queue.get_nowait()
        self.assertEqual(kind, "end")
        self.assertIs(payload, controller.outcome)
        self.assertIsNone(meta)


if __name__ == "__main__":
    unittest.main()
