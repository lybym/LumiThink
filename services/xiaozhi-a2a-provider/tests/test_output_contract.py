"""§9.3 output-contract unit tests (pure stdlib; no SDK import needed).

Pins the frozen dedup/continuity/digest/replacement semantics that the
voice channel must enforce (A2A_DESIGN §9.3/§10.1, issue #115).
"""
import unittest

from xiaozhi_a2a_provider.output_contract import (
    AnswerStreamAccumulator,
    ContractViolation,
    artifact_is_playable,
    dedup_key,
    parse_output_chunk,
    sha256_hex,
)

ANSWER_META = {"lumithinkContent": {"version": 1, "category": "admitted-answer"}}


def chunk_meta(chunk_id, text, start):
    return {
        "lumithinkOutput": {
            "version": 1,
            "chunkId": chunk_id,
            "startByte": start,
            "endByte": start + len(text.encode("utf-8")),
            "sha256": sha256_hex(text),
        }
    }


def reason_of(callable_, *args, **kwargs):
    try:
        callable_(*args, **kwargs)
    except ContractViolation as violation:
        return violation.reason
    raise AssertionError("expected ContractViolation, none raised")


class TestParseOutputChunk(unittest.TestCase):
    def test_accepts_wellformed_metadata(self):
        chunk = parse_output_chunk(chunk_meta("answer#chunk-1", "你好。", 0))
        self.assertEqual(chunk.chunk_id, "answer#chunk-1")
        self.assertEqual((chunk.start_byte, chunk.end_byte), (0, 9))

    def test_accepts_json_float_number_shape(self):
        meta = chunk_meta("c1", "你好。", 0)
        raw = meta["lumithinkOutput"]
        raw["startByte"] = float(raw["startByte"])
        raw["endByte"] = float(raw["endByte"])
        raw["version"] = float(raw["version"])
        chunk = parse_output_chunk(meta)
        self.assertEqual(chunk.start_byte, 0)

    def test_rejects_missing_and_malformed(self):
        with self.assertRaises(ContractViolation):
            parse_output_chunk(None)
        with self.assertRaises(ContractViolation):
            parse_output_chunk({})
        bad = chunk_meta("c1", "你好。", 0)
        bad["lumithinkOutput"]["version"] = 2
        self.assertEqual(reason_of(parse_output_chunk, bad), "bad_output_metadata")
        no_id = chunk_meta("", "你好。", 0)
        self.assertEqual(reason_of(parse_output_chunk, no_id), "bad_output_metadata")
        reversed_range = chunk_meta("c1", "你好。", 5)
        reversed_range["lumithinkOutput"]["endByte"] = 3
        self.assertEqual(reason_of(parse_output_chunk, reversed_range), "bad_output_metadata")
        bad_digest = chunk_meta("c1", "你好。", 0)
        bad_digest["lumithinkOutput"]["sha256"] = "nothex"
        self.assertEqual(reason_of(parse_output_chunk, bad_digest), "bad_output_metadata")


class TestAnswerStreamAccumulator(unittest.TestCase):
    def setUp(self):
        self.acc = AnswerStreamAccumulator("task-1")

    def ingest(self, chunk_id, text, start, *, append, last_chunk=False,
               artifact_id="answer-example", artifact_meta=ANSWER_META, event_meta=None):
        return self.acc.ingest_event(
            artifact_id=artifact_id,
            artifact_metadata=artifact_meta,
            event_metadata=event_meta if event_meta is not None else chunk_meta(chunk_id, text, start),
            text=text,
            append=append,
            last_chunk=last_chunk,
        )

    def test_first_chunk_accepted_and_delivered(self):
        result = self.ingest("answer#chunk-1", "你好。", 0, append=False)
        self.assertTrue(result.playable)
        self.assertFalse(result.duplicate)
        self.assertEqual(result.new_text, "你好。")

    def test_duplicate_same_id_same_content_is_filtered(self):
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        replay = self.ingest("answer#chunk-1", "你好。", 0, append=True)
        self.assertTrue(replay.duplicate)
        self.assertEqual(replay.new_text, "")
        self.assertEqual(self.acc.watermark_of("answer-example"), 9)

    def test_same_id_different_content_is_anomaly(self):
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        reason = reason_of(self.ingest, "answer#chunk-1", "被篡改。", 0, append=True)
        self.assertEqual(reason, "same_id_different_content")
        self.assertEqual(self.acc.violations, 1)

    def test_repeated_text_with_new_id_is_new_content(self):
        # Text-content dedup is FORBIDDEN: legit repeated words survive.
        first = self.ingest("answer#chunk-1", "好好。", 0, append=False)
        second = self.ingest("answer#chunk-2", "好好。", 9, append=True)
        self.assertEqual(first.new_text, "好好。")
        self.assertEqual(second.new_text, "好好。")

    def test_byte_gap_is_non_contiguous(self):
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        reason = reason_of(self.ingest, "answer#chunk-2", "我们开始吧。", 12, append=True)
        self.assertEqual(reason, "non_contiguous_range")

    def test_rewinding_range_is_prefix_replacement(self):
        self.ingest("answer#chunk-1", "你好。我们开始吧。", 0, append=False)
        reason = reason_of(self.ingest, "answer#chunk-2", "覆盖", 3, append=True)
        self.assertEqual(reason, "published_prefix_replacement")

    def test_sha256_mismatch_rejected(self):
        bad = chunk_meta("answer#chunk-1", "你好。", 0)
        bad["lumithinkOutput"]["sha256"] = sha256_hex("别的内容")
        reason = reason_of(self.ingest, "answer#chunk-1", "你好。", 0, append=False, event_meta=bad)
        self.assertEqual(reason, "sha256_mismatch")

    def test_append_false_over_published_prefix_rejected(self):
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        reason = reason_of(self.ingest, "answer#chunk-2", "我们开始吧。", 9, append=False)
        self.assertEqual(reason, "published_prefix_replacement")

    def test_append_true_on_unpublished_artifact_rejected(self):
        reason = reason_of(self.ingest, "answer#chunk-1", "你好。", 0, append=True)
        self.assertEqual(reason, "append_without_creation")

    def test_chunk_after_last_chunk_rejected(self):
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        self.ingest("answer#chunk-2", "我们开始吧。", 9, append=True, last_chunk=True)
        reason = reason_of(self.ingest, "answer#chunk-3", "迟到。", 24, append=True)
        self.assertEqual(reason, "chunk_after_last_chunk")

    def test_non_answer_artifact_never_plays(self):
        structured = {"lumithinkContent": {"version": 1, "category": "structured-facts"}}
        result = self.ingest("facts-1", '{"a":1}', 0, append=False, artifact_id="facts", artifact_meta=structured)
        self.assertFalse(result.playable)
        self.assertEqual(result.new_text, "")
        self.assertFalse(artifact_is_playable(None))
        self.assertFalse(artifact_is_playable({}))

    def test_snapshot_rebuild_sets_boundary_and_filters_replay(self):
        # Delivered prefix before the disconnect:
        self.ingest("answer#chunk-1", "你好。", 0, append=False)
        # Snapshot aggregation (no per-fragment metadata by contract):
        self.acc.rebuild_from_snapshot("answer-example", ANSWER_META, "你好。")
        # Honest redelivery of the same fragment through the new subscription:
        replay = self.ingest("answer#chunk-1", "你好。", 0, append=True)
        self.assertTrue(replay.duplicate)
        # The next increment passes:
        nxt = self.ingest("answer#chunk-2", "我们开始吧。", 9, append=True)
        self.assertEqual(nxt.new_text, "我们开始吧。")

    def test_snapshot_rebuild_accepts_shorter_when_nothing_delivered(self):
        self.acc.rebuild_from_snapshot("answer-example", ANSWER_META, "")
        self.assertEqual(self.acc.watermark_of("answer-example"), 0)

    def test_snapshot_shrink_is_violation(self):
        self.ingest("answer#chunk-1", "你好。我们开始吧。", 0, append=False)
        reason = reason_of(self.acc.rebuild_from_snapshot, "answer-example", ANSWER_META, "你好。")
        self.assertEqual(reason, "snapshot_shrink")

    def test_replacement_event_after_snapshot_rebuild_rejected(self):
        self.acc.rebuild_from_snapshot("answer-example", ANSWER_META, "你好。我们开始吧。")
        reason = reason_of(self.ingest, "answer#chunk-9", "替换", 0, append=False)
        self.assertEqual(reason, "published_prefix_replacement")

    def test_dedup_key_is_triple_not_text(self):
        self.assertEqual(dedup_key("t", "a", "c"), ("t", "a", "c"))
        self.assertNotEqual(dedup_key("t", "a", "c1"), dedup_key("t", "a", "c2"))


if __name__ == "__main__":
    unittest.main()
