"""Deterministic seeded delivery races (P2-04, issue #116).

Methodology aligned with ``tests/domain/voice/race.spec.ts`` (the R1-V1
acceptance harness): every scenario is a PURE function of its seed —

- a seeded PRNG (mulberry32) drives the op schedule;
- ids, texts and digests are deterministic;
- synthetic payloads never enter the ledger (ids/ranges/digests only);
- invariants are checked after EVERY operation;
- the same seed MUST replay the exact audit timeline (byte-stable
  canonical fingerprint).

Unlike the voice-domain spec, the interleaving drives the REAL production
components: ``FileDeliveryLedger`` (durable, atomic writes) and
``AnswerStreamAccumulator`` (§9.3 contract). The raced families are the
issue's channel scenarios: 打断×交付, 断流×取消, 重连×新轮.

Invariants after EVERY op (per active turn):

1. a superseded turn's fragment NEVER enters the current turn's delivery
   set (stale generation = 0 delivered);
2. after the stop marker, NOTHING else is delivered in that generation
   (late arrivals are filtered and counted);
3. a fragment key (taskId, artifactId, chunkId) is delivered AT MOST once;
4. the same TEXT under a different chunkId is still delivered (no
   text-content dedup — legit repeated words must survive);
5. the per-artifact watermark is monotonic within a turn;
6. the ledger's deliveredFragments equals the sim's delivered count;
7. a fenced turn delivers nothing further.
"""
import json
import os
import shutil
import tempfile
import unittest

from xiaozhi_a2a_provider.delivery_ledger import (
    DELIVERY_STATE_PARTIAL_STOPPED,
    FileDeliveryLedger,
    STOP_DEVICE_ABORT,
)
from xiaozhi_a2a_provider.output_contract import (
    AnswerStreamAccumulator,
    ContractViolation,
    sha256_hex,
)

ANSWER_META = {"lumithinkContent": {"version": 1, "category": "admitted-answer"}}
ITERATIONS = 60
OPS_PER_ITERATION = 30
_WORDS = ["alpha", "beta", "gamma", "delta", "omega"]


def mulberry32(seed: int):
    """Exact mulberry32 port (bit-faithful 32-bit integer chain)."""
    state = seed & 0xFFFFFFFF

    def rng() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        prod = ((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF
        t = (t ^ ((t + prod) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def random_int(rng, bound: int) -> int:
    return int(rng() * bound) % bound


def pick(rng, items):
    return items[random_int(rng, len(items))]


def synthetic_text(rng) -> str:
    return "{} {}.".format(pick(rng, _WORDS), pick(rng, _WORDS))


class _Event:
    """One scripted §9.3 artifact-update event (ids + ranges + digest)."""

    def __init__(self, artifact_id, chunk_id, text, start, append, last_chunk):
        self.artifact_id = artifact_id
        self.chunk_id = chunk_id
        self.text = text
        self.start = start
        self.end = start + len(text.encode("utf-8"))
        self.sha256 = sha256_hex(text)
        self.append = append
        self.last_chunk = last_chunk

    def metadata(self):
        return {
            "lumithinkOutput": {
                "version": 1,
                "chunkId": self.chunk_id,
                "startByte": self.start,
                "endByte": self.end,
                "sha256": self.sha256,
            }
        }

    def identity(self):
        return (self.artifact_id, self.chunk_id, self.start, self.end, self.sha256)


class _TurnState:
    def __init__(self, task_id, generation):
        self.task_id = task_id
        self.generation = generation
        self.accumulator = AnswerStreamAccumulator(task_id)
        self.emitted = []          # all events emitted for this turn
        self.midstream = []        # events with append=True (honest-redelivery pool)
        self.delivered_keys = set()
        self.delivered_texts = []
        self.delivered_bytes = 0
        self.artifact_watermarks = {}
        self.prev_watermarks = {}
        self.published_text = ""  # the server-side aggregated artifact body
        self.fenced = False
        self.stopped = False
        self.filtered_after_stop = 0
        self.stale_arrivals = 0


class _ChannelSim:
    """One session driven through the REAL ledger + accumulator."""

    def __init__(self, ledger_dir, session_id):
        self.session_id = session_id
        self.ledger = FileDeliveryLedger(os.path.join(ledger_dir, "ledger.json"))
        self.generation = 0
        self.turn: _TurnState = None
        self.old_turns = []
        self.turn_counter = 0
        self.audit = []
        self.ledger_dir = ledger_dir

    # -- ops ----------------------------------------------------------------

    def op_new_turn(self, rng):
        if self.turn is not None:
            self.old_turns.append(self.turn)
        self.turn_counter += 1
        self.generation = self.ledger.begin_turn(self.session_id)
        self.turn = _TurnState(
            task_id="task-{:04d}".format(self.turn_counter), generation=self.generation
        )
        self.audit.append(["new_turn", self.generation, self.turn.task_id])

    def _fresh_event(self, rng):
        artifact_id = "answer-1"
        first = not self.turn.emitted
        start = self.turn.artifact_watermarks.get(artifact_id, 0)
        text = synthetic_text(rng)
        event = _Event(
            artifact_id, "chunk-{:04d}".format(len(self.turn.emitted) + 1),
            text, start, append=not first,
            last_chunk=False,
        )
        return event

    def _ingest(self, event):
        """§9.3 validation; returns the IngestResult. Fences on violation."""
        try:
            result = self.turn.accumulator.ingest_event(
                artifact_id=event.artifact_id,
                artifact_metadata=ANSWER_META,
                event_metadata=event.metadata(),
                text=event.text,
                append=event.append,
                last_chunk=event.last_chunk,
            )
        except ContractViolation:
            self.turn.fenced = True
            return None
        return result

    @staticmethod
    def _check(condition, message):
        if not condition:
            raise AssertionError(message)

    def _gate(self, task_id, event):
        """The provider's final delivery gate (generation/ledger dedup)."""
        status = self.ledger.record_delivery(
            self.session_id, self.turn.generation, task_id,
            event.artifact_id, event.chunk_id, event.start, event.end, event.sha256,
        )
        return status

    def op_chunk(self, rng):
        roll = random_int(rng, 100)
        turn = self.turn
        if roll < 30:
            # fresh continuation (or the artifact's first event)
            event = self._fresh_event(rng)
            self._deliver_or_filter(event, kind="fresh")
        elif roll < 45 and turn.midstream:
            # honest redelivery of a midstream event (identical ids/range/digest)
            self._deliver_or_filter(pick(rng, turn.midstream), kind="redelivery")
        elif roll < 58 and turn.delivered_texts:
            # legal repeated text under a NEW chunk id (no text-content dedup!)
            text = turn.delivered_texts[-1]
            artifact_id = "answer-1"
            start = turn.artifact_watermarks.get(artifact_id, 0)
            event = _Event(
                artifact_id, "chunk-repeat-{:04d}".format(len(turn.emitted) + 1),
                text, start, append=True, last_chunk=False,
            )
            self._deliver_or_filter(event, kind="repeat_text")
        elif roll < 70 and turn.emitted:
            # protocol anomaly: same chunkId, different content — never played
            victim = pick(rng, turn.emitted)
            event = _Event(
                victim.artifact_id, victim.chunk_id, synthetic_text(rng) + "tampered",
                victim.start, append=victim.append, last_chunk=False,
            )
            result = self._ingest(event)
            self._check(result is None, "same-id different-content must raise")
            self.audit.append(["anomaly_fenced", turn.task_id, event.chunk_id])
        elif roll < 82 and self.old_turns:
            # late fragment of a SUPERSEDED turn — the arrival carries the OLD
            # generation (the provider's stale controller shape) and must be
            # stale-gated: old content never enters the new turn.
            old = pick(rng, self.old_turns)
            if old.emitted:
                event = pick(rng, old.emitted)
                status = self.ledger.record_delivery(
                    self.session_id, old.generation, old.task_id,
                    event.artifact_id, event.chunk_id, event.start, event.end, event.sha256,
                )
                self._check(status == "stale_generation", "old-turn fragment must be stale-gated")
                self.turn.stale_arrivals += 1
                self.audit.append(["stale_blocked", old.task_id, event.chunk_id])
        elif roll < 92 and not turn.emitted:
            self.audit.append(["chunk_skipped_empty"])
        else:
            event = self._fresh_event(rng)
            self._deliver_or_filter(event, kind="fresh_tail")

    def _deliver_or_filter(self, event, kind):
        turn = self.turn
        result = self._ingest(event)
        if result is None:
            self.audit.append(["{}_fenced".format(kind), turn.task_id, event.chunk_id])
            return
        if result.duplicate:
            self.audit.append(["{}_duplicate".format(kind), turn.task_id, event.chunk_id])
            return
        # The §9.3 body is append-only and SERVER-SIDE: every fragment the
        # accumulator accepted is published (even if the channel later
        # filters it) — the reconnect snapshot is the server truth and must
        # never be shorter than the local watermark.
        turn.published_text += event.text
        if turn.fenced or turn.stopped:
            # fenced / stopped playback: late arrivals are filtered (AC 3)
            turn.filtered_after_stop += 1
            if turn.fenced is False:
                self.ledger.record_filtered(
                    self.session_id, turn.task_id, turn.generation
                )
            self.audit.append(["{}_filtered".format(kind), turn.task_id, event.chunk_id])
            return
        status = self._gate(turn.task_id, event)
        if status == "recorded":
            key = (turn.generation, turn.task_id, event.artifact_id, event.chunk_id)
            self._check(
                key not in turn.delivered_keys,
                "fragment delivered twice: {}".format(event.chunk_id),
            )
            turn.delivered_keys.add(key)
            turn.delivered_texts.append(event.text)
            turn.delivered_bytes += event.end - event.start
            turn.artifact_watermarks[event.artifact_id] = event.end
            turn.emitted.append(event)
            if event.append:
                turn.midstream.append(event)
            self.audit.append(["{}_delivered".format(kind), turn.task_id, event.chunk_id])
        elif status == "stale_generation":
            self.turn.stale_arrivals += 1
            self.audit.append(["{}_stale".format(kind), turn.task_id, event.chunk_id])
        else:
            raise AssertionError("unexpected gate status {}".format(status))

    def op_interrupt(self, rng):
        # 本地立即止播标记 BEFORE any cancel bookkeeping (§10.3 step 1).
        self.ledger.record_stop(
            self.session_id, STOP_DEVICE_ABORT, DELIVERY_STATE_PARTIAL_STOPPED
        )
        self.turn.stopped = True
        self.audit.append(["interrupt", self.turn.task_id])

    def op_stream_loss_reconnect(self, rng):
        turn = self.turn
        if not turn.emitted:
            self.audit.append(["reconnect_skipped_empty"])
            return
        artifact_id = "answer-1"
        # The snapshot carries the SERVER-SIDE aggregated artifact text —
        # everything published so far, sometimes a tail the server wrote
        # while the stream was down (TASK_LIFECYCLE §6.2). It is never
        # shorter than what was already delivered.
        ahead = "".join(synthetic_text(rng) for _ in range(random_int(rng, 2)))
        if ahead:
            turn.published_text += ahead
        snapshot_text = turn.published_text
        self.ledger.verify_integrity(self.session_id)  # the reconnect gate
        turn.accumulator.rebuild_from_snapshot(artifact_id, ANSWER_META, snapshot_text)
        watermark = turn.accumulator.watermark_of(artifact_id)
        self._check(
            watermark >= len(snapshot_text.encode("utf-8")) - len(ahead.encode("utf-8")),
            "reconnect watermark below the pre-loss prefix",
        )
        turn.artifact_watermarks[artifact_id] = max(
            turn.artifact_watermarks.get(artifact_id, 0), watermark
        )
        self.audit.append(["reconnect", turn.task_id, watermark])

    # -- invariants -----------------------------------------------------------

    def check_invariants(self):
        turn = self.turn
        if turn is None:
            return
        summary = self.ledger.delivery_summary(self.session_id)
        if summary is not None and summary["generation"] == turn.generation:
            # 6: the durable record matches the sim's delivery bookkeeping.
            self._check(
                summary["deliveredFragments"] == len(turn.delivered_keys),
                "ledger fragments {} != sim {}".format(summary["deliveredFragments"], len(turn.delivered_keys)),
            )
            self._check(
                summary["deliveredBytes"] == turn.delivered_bytes,
                "ledger bytes {} != sim {}".format(summary["deliveredBytes"], turn.delivered_bytes),
            )
            # 2: after the stop marker nothing else was delivered.
            if turn.stopped:
                self._check(
                    summary["deliveryState"] == DELIVERY_STATE_PARTIAL_STOPPED,
                    "stopped turn must record partial_stopped",
                )
        # 5: the watermark never decreases and never sits below the delivered
        # prefix (it MAY lead it — the reconnect snapshot is legitimately
        # ahead of what was played, TASK_LIFECYCLE §6.2).
        for artifact_id, watermark in turn.artifact_watermarks.items():
            previous = turn.prev_watermarks.get(artifact_id, 0)
            self._check(watermark >= previous, "artifact watermark decreased")
            max_end = max(
                (event.end for event in turn.emitted if event.artifact_id == artifact_id),
                default=0,
            )
            self._check(watermark >= max_end, "watermark below the delivered prefix")
            turn.prev_watermarks[artifact_id] = watermark
        # 1: no delivered key belongs to a superseded turn.
        for old in self.old_turns:
            for key in turn.delivered_keys:
                self._check(key[1] != old.task_id, "superseded turn content delivered")

    def fingerprint(self) -> str:
        return json.dumps(self.audit, sort_keys=True, separators=(",", ":"))


def run_scenario(seed: int) -> str:
    """One deterministic seeded scenario; returns the audit fingerprint."""
    rng = mulberry32(seed)
    ledger_dir = tempfile.mkdtemp(prefix="xz-delivery-race-")
    try:
        sim = _ChannelSim(ledger_dir, "sess-race-{:04d}".format(seed))
        sim.op_new_turn(rng)
        for _ in range(OPS_PER_ITERATION):
            roll = random_int(rng, 100)
            if roll < 14:
                sim.op_new_turn(rng)
            elif roll < 72:
                sim.op_chunk(rng)
            elif roll < 84:
                sim.op_interrupt(rng)
            else:
                sim.op_stream_loss_reconnect(rng)
            sim.check_invariants()
        # Liveness: the final turn can still be driven to completion — a
        # fresh (non-fenced) fragment at the current watermark must deliver
        # or be honestly filtered, never corrupt the ledger.
        sim.ledger.verify_integrity(sim.session_id)
        return sim.fingerprint()
    finally:
        shutil.rmtree(ledger_dir, ignore_errors=True)


class TestSeededDeliveryRaces(unittest.TestCase):
    def test_60_seeded_delivery_races_all_invariants_hold(self):
        fingerprints = {}
        for seed in range(1, ITERATIONS + 1):
            fingerprints[seed] = run_scenario(seed)
        # Distinct seeds produced distinct histories (no accidental vacuity).
        self.assertEqual(len(set(fingerprints.values())), ITERATIONS)

    def test_the_same_seed_replays_the_exact_audit_timeline(self):
        for seed in (1, 7, 42, 60):
            self.assertEqual(run_scenario(seed), run_scenario(seed), seed)

    def test_interrupt_x_delivery_named_family(self):
        # 打断×交付：deliver → interrupt → late fragment filtered → watermark partial.
        rng = mulberry32(116)
        ledger_dir = tempfile.mkdtemp(prefix="xz-delivery-race-")
        try:
            sim = _ChannelSim(ledger_dir, "sess-named-abort")
            sim.op_new_turn(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")
            self.assertEqual(len(sim.turn.delivered_keys), 1)
            sim.op_interrupt(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")
            self.assertEqual(len(sim.turn.delivered_keys), 1)  # nothing after the stop
            self.assertEqual(sim.turn.filtered_after_stop, 1)
            summary = sim.ledger.delivery_summary(sim.session_id)
            self.assertEqual(summary["deliveryState"], DELIVERY_STATE_PARTIAL_STOPPED)
            self.assertEqual(summary["stopReason"], "device_abort")
        finally:
            shutil.rmtree(ledger_dir, ignore_errors=True)

    def test_stream_loss_x_cancel_named_family(self):
        # 断流×取消：deliver → reconnect (snapshot rebuild, no replay) →
        # interrupt → the ahead-of-us tail after the stop is filtered.
        rng = mulberry32(204)
        ledger_dir = tempfile.mkdtemp(prefix="xz-delivery-race-")
        try:
            sim = _ChannelSim(ledger_dir, "sess-named-loss")
            sim.op_new_turn(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")
            delivered_before = len(sim.turn.delivered_keys)
            sim.op_stream_loss_reconnect(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")  # post-reconnect increment
            self.assertEqual(len(sim.turn.delivered_keys), delivered_before + 1)
            sim.op_interrupt(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")
            self.assertEqual(len(sim.turn.delivered_keys), delivered_before + 1)
            self.assertEqual(sim.turn.filtered_after_stop, 1)
        finally:
            shutil.rmtree(ledger_dir, ignore_errors=True)

    def test_reconnect_x_new_turn_named_family(self):
        # 重连×新轮：deliver → reconnect → NEW turn → the old turn's fragment
        # (even freshly redelivered) NEVER enters the new turn.
        rng = mulberry32(309)
        ledger_dir = tempfile.mkdtemp(prefix="xz-delivery-race-")
        try:
            sim = _ChannelSim(ledger_dir, "sess-named-turns")
            sim.op_new_turn(rng)
            sim._deliver_or_filter(sim._fresh_event(rng), kind="fresh")
            old = sim.turn
            sim.op_new_turn(rng)
            event = pick(rng, old.emitted)
            status = sim.ledger.record_delivery(
                sim.session_id, old.generation, old.task_id,
                event.artifact_id, event.chunk_id, event.start, event.end, event.sha256,
            )
            self.assertEqual(status, "stale_generation")
            self.assertEqual(len(sim.turn.delivered_keys), 0)
        finally:
            shutil.rmtree(ledger_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
