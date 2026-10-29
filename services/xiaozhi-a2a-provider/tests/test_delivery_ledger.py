"""Channel-delivery watermark ledger unit tests (P2-04, issue #116).

Covers the durable consumer-side record: atomic persistence, per-turn
generations (old-turn isolation), stable-id fragment records with
duplicate/anomaly detection, stop markers, the READ-ONLY Task-state
observation (播放完成 ≠ Task 完成) and the fail-closed integrity gate.
All content synthetic and content-free (the ledger never receives text).
"""
import json
import os
import tempfile
import unittest

from xiaozhi_a2a_provider.delivery_ledger import (
    DELIVERY_LEDGER_SCHEMA_VERSION,
    DELIVERY_STATE_COMPLETE,
    DELIVERY_STATE_PARTIAL_STOPPED,
    DELIVERY_STATE_UNCERTAIN,
    DeliveryLedgerError,
    FileDeliveryLedger,
    MemoryDeliveryLedger,
    STATUS_DUPLICATE,
    STATUS_RECORDED,
    STATUS_STALE_GENERATION,
)

DIGEST_A = "a" * 64
DIGEST_B = "b" * 64


def record(ledger, session="s1", generation=1, task="task-1", artifact="ans-1",
           chunk="c1", start=0, end=9, digest=DIGEST_A):
    return ledger.record_delivery(session, generation, task, artifact, chunk, start, end, digest)


class TestFragmentRecords(unittest.TestCase):
    def setUp(self):
        self.ledger = MemoryDeliveryLedger()
        self.generation = self.ledger.begin_turn("s1")

    def test_record_update_watermark_and_summary(self):
        self.assertEqual(record(self.ledger, start=0, end=9), STATUS_RECORDED)
        self.assertEqual(record(self.ledger, chunk="c2", start=9, end=18), STATUS_RECORDED)
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["deliveredFragments"], 2)
        self.assertEqual(summary["deliveredBytes"], 18)
        self.assertEqual(summary["artifactWatermarks"]["ans-1"], 18)
        self.assertEqual(summary["generation"], 1)
        self.assertFalse(summary["superseded"])

    def test_identical_redelivery_is_duplicate(self):
        record(self.ledger)
        self.assertEqual(record(self.ledger), STATUS_DUPLICATE)
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["deliveredFragments"], 1)
        self.assertEqual(summary["duplicateFragments"], 1)

    def test_same_id_different_content_is_anomaly(self):
        record(self.ledger)
        with self.assertRaises(DeliveryLedgerError) as caught:
            record(self.ledger, digest=DIGEST_B)
        self.assertEqual(caught.exception.reason, "same_id_different_delivery")
        # same key, same range, different digest → never absorbed silently
        self.assertEqual(self.ledger.delivery_summary("s1")["deliveredFragments"], 1)

    def test_watermark_rewind_is_anomaly(self):
        record(self.ledger, start=0, end=18)
        with self.assertRaises(DeliveryLedgerError):
            record(self.ledger, chunk="c2", start=0, end=9)

    def test_legal_repeated_text_new_chunk_id_still_delivers(self):
        # 去重按键不做文本内容去重：合法重复词句必须存活（§9.3）。
        self.assertEqual(record(self.ledger, chunk="c1", start=0, end=9), STATUS_RECORDED)
        self.assertEqual(
            record(self.ledger, chunk="c2", start=9, end=18, digest=DIGEST_A),
            STATUS_RECORDED,
        )
        self.assertEqual(self.ledger.delivery_summary("s1")["deliveredFragments"], 2)

    def test_stable_ids_required(self):
        with self.assertRaises(DeliveryLedgerError):
            record(self.ledger, task="")
        with self.assertRaises(DeliveryLedgerError):
            record(self.ledger, artifact="")
        with self.assertRaises(DeliveryLedgerError):
            record(self.ledger, chunk="")


class TestGenerations(unittest.TestCase):
    def setUp(self):
        self.ledger = MemoryDeliveryLedger()

    def test_begin_turn_bumps_and_supersedes(self):
        first = self.ledger.begin_turn("s1")
        record(self.ledger, generation=first)
        second = self.ledger.begin_turn("s1")
        self.assertEqual(second, first + 1)
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["generation"], first)  # latest RECORDED turn
        self.assertEqual(summary["sessionGeneration"], second)  # session is ahead
        self.assertTrue(summary["superseded"])  # the OLD turn is superseded

    def test_old_generation_delivery_is_stale_never_recorded(self):
        old = self.ledger.begin_turn("s1")
        record(self.ledger, generation=old, task="task-old")
        self.ledger.begin_turn("s1")
        self.assertEqual(
            record(self.ledger, generation=old, task="task-old", chunk="c-late"),
            STATUS_STALE_GENERATION,
        )
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["generation"], old)  # latest RECORDED turn
        self.assertEqual(summary["sessionGeneration"], old + 1)  # session is ahead
        self.assertEqual(summary["deliveredFragments"], 1)  # only the pre-bump record
        # ...and the late fragment never entered the watermark:
        self.assertNotIn("ans-1/c-late", summary["fragments"])

    def test_current_generation_delivery_lands_on_current_turn(self):
        gen = self.ledger.begin_turn("s1")
        record(self.ledger, generation=gen, task="task-2")
        record(self.ledger, generation=gen, task="task-2", chunk="c2", start=9, end=18)
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["deliveredFragments"], 2)
        self.assertEqual(summary["generation"], gen)

    def test_record_filtered_counts_current_generation_only(self):
        gen = self.ledger.begin_turn("s1")
        self.ledger.record_filtered("s1", "task-1", gen)
        self.ledger.record_filtered("s1", "task-1", gen)
        self.ledger.record_filtered("s1", "task-1", 99)  # stale: ignored here
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["filteredAfterStop"], 2)
        self.assertEqual(summary["staleGenerationFragments"], 0)

    def test_generations_persist_across_ledger_reload(self):
        directory = tempfile.mkdtemp(prefix="xz-ledger-gen-")
        path = os.path.join(directory, "ledger.json")
        first = FileDeliveryLedger(path).begin_turn("s1")
        reopened = FileDeliveryLedger(path)
        self.assertEqual(reopened.begin_turn("s1"), first + 1)


class TestStopAndObservation(unittest.TestCase):
    def setUp(self):
        self.ledger = MemoryDeliveryLedger()
        self.generation = self.ledger.begin_turn("s1")

    def test_stop_marker_sets_reason_and_state(self):
        record(self.ledger)  # delivery happened, then the device interrupted
        self.ledger.record_stop("s1", "device_abort", DELIVERY_STATE_PARTIAL_STOPPED)
        summary = self.ledger.delivery_summary("s1")
        self.assertTrue(summary["stopped"])
        self.assertEqual(summary["stopReason"], "device_abort")
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_PARTIAL_STOPPED)

    def test_task_observation_is_separate_from_delivery_state(self):
        # 播放完成 ≠ Task 完成：COMPLETED + suppressed 观察只落在观察位。
        record(self.ledger)
        self.ledger.record_stop("s1", "device_abort", DELIVERY_STATE_PARTIAL_STOPPED)
        self.ledger.record_task_observation(
            "s1", "task-1", self.generation,
            task_state="TASK_STATE_COMPLETED",
            answer_complete=False,
            output_suppressed_after_cancel=True,
            delivery_state=DELIVERY_STATE_PARTIAL_STOPPED,
        )
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["taskStateObserved"], "TASK_STATE_COMPLETED")
        self.assertFalse(summary["answerCompleteObserved"])
        self.assertTrue(summary["outputSuppressedAfterCancelObserved"])
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_PARTIAL_STOPPED)
        self.assertEqual(summary["deliveredFragments"], 1)  # partial, not full

    def test_full_delivery_state_complete(self):
        record(self.ledger)
        self.ledger.record_task_observation(
            "s1", "task-1", self.generation, "TASK_STATE_COMPLETED", True, False,
            DELIVERY_STATE_COMPLETE,
        )
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_COMPLETE)
        self.assertTrue(summary["answerCompleteObserved"])

    def test_uncertain_default_for_unsettled_turn(self):
        record(self.ledger)
        summary = self.ledger.delivery_summary("s1")
        self.assertEqual(summary["deliveryState"], DELIVERY_STATE_UNCERTAIN)
        self.assertIsNone(summary["taskStateObserved"])

    def test_summary_missing_for_unknown_session(self):
        self.assertIsNone(self.ledger.delivery_summary("never-seen"))


class TestFileLedgerPersistence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="xz-ledger-file-")
        self.path = os.path.join(self.directory, "ledger.json")

    def test_atomic_document_on_disk_and_ascii_only(self):
        ledger = FileDeliveryLedger(self.path)
        generation = ledger.begin_turn("s1")
        record(ledger, generation=generation)
        with open(self.path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
        self.assertEqual(doc["version"], DELIVERY_LEDGER_SCHEMA_VERSION)
        self.assertEqual(len(os.listdir(self.directory)), 1)  # no tmp leftovers
        # 内容无关纪律：账本里只有 id/区间/摘要/计数——正文永不落盘。
        with open(self.path, "rb") as handle:
            raw = handle.read()
        self.assertTrue(raw.decode("utf-8").isascii())
        self.assertNotIn("你好".encode("utf-8"), raw)

    def test_corrupt_file_refuses_to_open(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        with self.assertRaises(DeliveryLedgerError) as caught:
            FileDeliveryLedger(self.path)
        self.assertEqual(caught.exception.reason, "ledger_corrupt")

    def test_unknown_future_version_refuses_to_open(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": DELIVERY_LEDGER_SCHEMA_VERSION + 1, "sessions": {}}, handle)
        with self.assertRaises(DeliveryLedgerError) as caught:
            FileDeliveryLedger(self.path)
        self.assertEqual(caught.exception.reason, "ledger_corrupt")

    def test_older_version_refuses_to_open(self):
        # 版本严格性对称（P2-05 review）：打开与完整性闸门同为精确版本匹配——
        # 过旧（或 0/负数）与过新同样拒绝。
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": DELIVERY_LEDGER_SCHEMA_VERSION - 1, "sessions": {}}, handle)
        with self.assertRaises(DeliveryLedgerError) as caught:
            FileDeliveryLedger(self.path)
        self.assertEqual(caught.exception.reason, "ledger_corrupt")

    def test_unrecognized_shape_refuses_to_open(self):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, "records": {}}, handle)
        with self.assertRaises(DeliveryLedgerError):
            FileDeliveryLedger(self.path)

    def test_restart_preserves_records(self):
        ledger = FileDeliveryLedger(self.path)
        generation = ledger.begin_turn("s1")
        record(ledger, generation=generation)
        reopened = FileDeliveryLedger(self.path)
        summary = reopened.delivery_summary("s1")
        self.assertEqual(summary["deliveredFragments"], 1)
        self.assertEqual(summary["generation"], generation)


class TestIntegrityGate(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.mkdtemp(prefix="xz-ledger-gate-")
        self.path = os.path.join(self.directory, "ledger.json")

    def test_healthy_file_passes(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        record(ledger)
        ledger.verify_integrity("s1")  # no raise

    def test_damaged_file_fails_closed(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        record(ledger)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("garbage-not-a-ledger")
        with self.assertRaises(DeliveryLedgerError) as caught:
            ledger.verify_integrity("s1")
        self.assertEqual(caught.exception.reason, "ledger_corrupt")

    def test_version_downgrade_or_shape_break_fails_closed(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": 99, "sessions": {}}, handle)
        with self.assertRaises(DeliveryLedgerError):
            ledger.verify_integrity("s1")

    def test_vanished_file_fails_closed_for_tracked_session(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        record(ledger)
        os.unlink(self.path)
        with self.assertRaises(DeliveryLedgerError) as caught:
            ledger.verify_integrity("s1")
        self.assertEqual(caught.exception.reason, "ledger_corrupt")

    def test_pruned_session_on_disk_fails_closed(self):
        # P2-05 review 钉死（fail-closed 语义）：磁盘文档合法且版本正确、但
        # 已不含被跟踪 session（外部剪除/改写历史）——消费水位无法对持久副本
        # 举证，完整性闸门拒绝并给出专用 reason（不静默重写内存视图）。
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        record(ledger)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"version": DELIVERY_LEDGER_SCHEMA_VERSION, "sessions": {}}, handle)
        with self.assertRaises(DeliveryLedgerError) as caught:
            ledger.verify_integrity("s1")
        self.assertEqual(caught.exception.reason, "session_missing_from_durable_ledger")

    def test_valid_disk_document_still_containing_session_passes(self):
        ledger = FileDeliveryLedger(self.path)
        ledger.begin_turn("s1")
        record(ledger)
        with open(self.path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(doc, handle)  # externally rewritten but complete
        ledger.verify_integrity("s1")  # no raise

    def test_missing_file_with_no_tracked_session_passes(self):
        ledger = FileDeliveryLedger(os.path.join(self.directory, "fresh.json"))
        ledger.verify_integrity("s1")  # fresh ledger, nothing tracked

    def test_memory_ledger_gate_is_process_local_noop(self):
        ledger = MemoryDeliveryLedger()
        ledger.begin_turn("s1")
        record(ledger)
        ledger.verify_integrity("s1")  # in-process consistency, no raise


if __name__ == "__main__":
    unittest.main()
