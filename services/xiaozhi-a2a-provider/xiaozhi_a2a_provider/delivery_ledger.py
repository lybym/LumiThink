"""Channel-delivery watermark ledger (P2-04, issue #116).

The consumer-side, channel-level record of what the xiaozhi voice channel
actually DELIVERED to the TTS generator — A2A_DESIGN §10.2 (渠道交付状态) and
TASK_LIFECYCLE §6 (正文消费位置单独记录). It is NOT a second task lifecycle
authority: the server-side SQLite store stays the ONLY authoritative Task
state (the P2-02 boundary statement, restated). This ledger records:

- per delivered fragment the §9.3 stable ids ``(taskId, artifactId,
  chunkId)`` + UTF-8 byte range + content digest — never the answer text
  itself (the ledger API has no text parameter and the persisted document
  is ASCII-only by construction);
- a per-session monotonic delivery ``generation``: every new voice turn
  bumps it and supersedes the previous turn's watermark (epoch-fencing
  analogue on the delivery plane — old-turn content can never enter a new
  turn);
- a stop marker (device abort / device closed) with a reason, so delivery
  and playback state are separable from the Task state observation;
- the observed terminal Task flags (``answerComplete`` /
  ``outputSuppressedAfterCancel``) as a READ-ONLY observation — playback
  completion is never written back as Task completion (§10.2: Task 不等待
  音频播放完成).

Persistence reuses the P2-02 ``FileTaskLedger`` discipline (A2A_DESIGN
§11: Channel Delivery uses its own storage, independent of the Task
state machine): a single versioned JSON document replaced atomically
(tmp file + ``os.replace``); a corrupt document or an unknown future
schema version refuses to run (fail-closed — the ledger is the durable
copy of the delivery watermark; TASK_LIFECYCLE §6.2: 没有可靠消费水位时
停止自动续播).

Recovery gate (issue #116 AC 8): :meth:`FileDeliveryLedger.verify_integrity`
re-reads the document FRESH FROM DISK (bypassing the in-memory cache). A
broken/missing durable copy while a session is tracked means "no reliable
consumption watermark" — the provider must then stop automatic continuation
and surface an explicit recovery state instead of replaying from scratch.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Dict, Optional

DELIVERY_LEDGER_SCHEMA_VERSION = 1

# Public, enumerated ledger reasons (stable evidence vocabulary; the provider
# fences on the protocol-anomaly class and degrades-with-counting on the
# write-failure one).
LEDGER_REASON_CORRUPT = "ledger_corrupt"
LEDGER_REASON_UNWRITABLE = "ledger_unwritable"
LEDGER_REASON_ANOMALY = "same_id_different_delivery"
LEDGER_REASON_SESSION_MISSING = "session_missing_from_durable_ledger"

# record_delivery outcomes (stable evidence vocabulary).
STATUS_RECORDED = "recorded"
STATUS_DUPLICATE = "duplicate"
STATUS_STALE_GENERATION = "stale_generation"

# Delivery stop reasons and delivery states (content-free vocabulary).
STOP_DEVICE_ABORT = "device_abort"
STOP_DEVICE_CLOSED = "device_closed"
DELIVERY_STATE_COMPLETE = "complete"
DELIVERY_STATE_PARTIAL_STOPPED = "partial_stopped"
DELIVERY_STATE_UNCERTAIN = "uncertain"

_REASON_CORRUPT = LEDGER_REASON_CORRUPT
_REASON_UNWRITABLE = LEDGER_REASON_UNWRITABLE
_REASON_ANOMALY = LEDGER_REASON_ANOMALY
_REASON_SESSION_MISSING = LEDGER_REASON_SESSION_MISSING


class DeliveryLedgerError(Exception):
    """A channel-delivery ledger breach; content-free, enumerated reason."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("delivery ledger error [{}]: {}".format(reason, detail))
        self.reason = reason
        self.detail = detail


class _DeliveryLedgerBase:
    """Shared in-memory document logic; persistence is the subclass hook.

    Subclasses implement ``_flush()`` (called under the lock after every
    mutation) and ``verify_integrity()`` (the reconnect gate).
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._doc: Dict = {"version": DELIVERY_LEDGER_SCHEMA_VERSION, "sessions": {}}

    # -- helpers ---------------------------------------------------------

    @staticmethod
    def _session(doc: Dict, session_id: str) -> Dict:
        sessions = doc["sessions"]
        if session_id not in sessions:
            sessions[session_id] = {
                "generation": 0,
                "stopped": False,
                "stopReason": None,
                "turns": {},
            }
        return sessions[session_id]

    @staticmethod
    def _turn(session: Dict, task_id: str, generation: int) -> Dict:
        turns = session["turns"]
        key = "{}@{}".format(generation, task_id)  # one turn == one (generation, task)
        if key not in turns:
            record = {
                "generation": generation,
                "superseded": False,
                "deliveryState": DELIVERY_STATE_UNCERTAIN,
                "stopReason": None,
                "artifactWatermarks": {},
                "fragments": {},
                "deliveredFragments": 0,
                "deliveredBytes": 0,
                "duplicateFragments": 0,
                "filteredAfterStop": 0,
                "staleGenerationFragments": 0,
                "taskStateObserved": None,
                "answerCompleteObserved": None,
                "outputSuppressedAfterCancelObserved": None,
            }
            if session.get("stopped"):
                # The stop marker predates this turn's first record (e.g. the
                # interrupt landed before any fragment was handed over): the
                # record inherits the stop evidence instead of claiming an
                # unmarked "uncertain" state.
                record["stopReason"] = session.get("stopReason")
                if session.get("stopDeliveryState"):
                    record["deliveryState"] = session["stopDeliveryState"]
            turns[key] = record
        return turns[key]

    def _flush(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    # -- the face used by the provider ------------------------------------

    def begin_turn(self, session_id: str) -> int:
        """Starts a new voice turn: bumps the generation and supersedes the
        previous turn's delivery watermark (issue #116 AC 5 — old-turn
        content can never enter the new turn)."""
        with self._lock:
            session = self._session(self._doc, session_id)
            session["generation"] += 1
            session["stopped"] = False
            session["stopReason"] = None
            session["stopDeliveryState"] = None
            for turn in session["turns"].values():
                if turn["generation"] < session["generation"]:
                    turn["superseded"] = True
            self._flush()
            return session["generation"]

    def record_delivery(
        self,
        session_id: str,
        generation: int,
        task_id: str,
        artifact_id: str,
        chunk_id: str,
        start_byte: int,
        end_byte: int,
        sha256: str,
    ) -> str:
        """Records one delivered fragment under its §9.3 stable ids.

        Returns :data:`STATUS_RECORDED`, :data:`STATUS_DUPLICATE` (an honest
        redelivery of an identical range+digest) or
        :data:`STATUS_STALE_GENERATION` (a fragment of an already-superseded
        turn — never recorded into the current watermark). A fragment whose
        stable key was already delivered with a DIFFERENT range/digest is a
        protocol anomaly and raises (fail-closed, never silently absorbed).
        """
        if not task_id or not artifact_id or not chunk_id:
            raise DeliveryLedgerError(_REASON_ANOMALY, "delivery record requires stable ids")
        with self._lock:
            session = self._session(self._doc, session_id)
            if generation != session["generation"]:
                return STATUS_STALE_GENERATION
            turn = self._turn(session, task_id, generation)
            fragments = turn["fragments"]
            key = "{}/{}".format(artifact_id, chunk_id)
            previous = fragments.get(key)
            if previous is not None:
                if previous == {
                    "startByte": start_byte,
                    "endByte": end_byte,
                    "sha256": sha256,
                }:
                    turn["duplicateFragments"] += 1
                    self._flush()
                    return STATUS_DUPLICATE
                raise DeliveryLedgerError(
                    _REASON_ANOMALY,
                    "chunkId {!r} already delivered with a different range/digest".format(chunk_id),
                )
            if start_byte < turn["artifactWatermarks"].get(artifact_id, 0):
                raise DeliveryLedgerError(
                    _REASON_ANOMALY,
                    "fragment startByte {} rewinds the artifact watermark {}".format(
                        start_byte, turn["artifactWatermarks"].get(artifact_id, 0)
                    ),
                )
            fragments[key] = {
                "startByte": start_byte,
                "endByte": end_byte,
                "sha256": sha256,
            }
            turn["artifactWatermarks"][artifact_id] = end_byte
            turn["deliveredFragments"] += 1
            turn["deliveredBytes"] += max(0, end_byte - start_byte)
            self._flush()
            return STATUS_RECORDED

    def record_filtered(self, session_id: str, task_id: str, generation: int) -> None:
        """Counts a late fragment that arrived after the stop marker (AC 3)."""
        with self._lock:
            session = self._session(self._doc, session_id)
            if generation != session["generation"]:
                return  # stale-generation arrivals are counted by the caller
            self._turn(session, task_id, generation)["filteredAfterStop"] += 1
            self._flush()

    def record_stop(self, session_id: str, reason: str, delivery_state: str) -> None:
        """Marks the local immediate stop of delivery/playback (AC 3/4).

        The stop marker is recorded BEFORE the CancelTask is sent — 本地立即
        止播标记 — and never rewrites any Task state.
        """
        with self._lock:
            session = self._session(self._doc, session_id)
            session["stopped"] = True
            session["stopReason"] = reason
            session["stopDeliveryState"] = delivery_state
            for turn in session["turns"].values():
                if turn["generation"] == session["generation"] and turn["taskStateObserved"] is None:
                    turn["stopReason"] = reason
                    if turn["deliveryState"] == DELIVERY_STATE_UNCERTAIN:
                        turn["deliveryState"] = delivery_state
            self._flush()

    def record_task_observation(
        self,
        session_id: str,
        task_id: str,
        generation: int,
        task_state: str,
        answer_complete: Optional[bool],
        output_suppressed_after_cancel: Optional[bool],
        delivery_state: str,
    ) -> None:
        """Records the observed terminal Task flags as READ-ONLY evidence.

        播放完成 ≠ Task 完成 (AC 4): the observation lands next to the
        delivery state, never instead of it, and never feeds back into any
        task authority.
        """
        with self._lock:
            session = self._session(self._doc, session_id)
            turn = self._turn(session, task_id, generation)
            turn["taskStateObserved"] = task_state
            turn["answerCompleteObserved"] = answer_complete
            turn["outputSuppressedAfterCancelObserved"] = output_suppressed_after_cancel
            turn["deliveryState"] = delivery_state
            self._flush()

    def delivery_summary(self, session_id: str) -> Optional[Dict]:
        """The content-free channel-delivery record of the latest turn.

        Returns a copy (the caller may hold it across turns). ``None`` when
        the session never delivered anything (summary missing = unknown,
        A2A_DESIGN §10.2 — it never blocks the agent).
        """
        with self._lock:
            session = self._doc["sessions"].get(session_id)
            if session is None:
                return None
            best: Optional[Dict] = None
            for turn in session["turns"].values():
                if best is None or turn["generation"] > best["generation"]:
                    best = turn
            if best is None:
                return None
            summary = json.loads(json.dumps(best))  # deep copy, JSON-only values
            # The record's own generation is the honest "latest recorded
            # delivery" — the session generation may already be ahead (a new
            # turn with no deliveries yet) and is reported separately.
            summary["generation"] = best["generation"]
            summary["sessionGeneration"] = session["generation"]
            summary["stopped"] = session["stopped"]
            summary["stopReason"] = session["stopReason"]
            return summary


class MemoryDeliveryLedger(_DeliveryLedgerBase):
    """Process-local ledger (no durable copy).

    Used only when the deployment wiring passes no ``delivery_ledger_path``;
    the watermark is then honest for the lifetime of the process but has no
    restart story — the reconnect gate (:meth:`verify_integrity`) is a
    no-op, so recovery still behaves (in-process state is consistent) while
    the README requires a file-backed ledger for durable deployments.
    """

    def _flush(self) -> None:
        pass  # in-process copy is the (only) copy; nothing to persist

    def verify_integrity(self, session_id: str) -> None:
        pass  # process-local consistency is guaranteed by the lock


class FileDeliveryLedger(_DeliveryLedgerBase):
    """Durable ledger: one versioned JSON document, atomically replaced.

    Same discipline as the P2-02 ``FileTaskLedger`` (services/dsh-a2a-client):
    write tmp in the same directory, ``os.replace`` over the target; a
    corrupt document or an unknown future schema version refuses to open
    (fail-closed — this ledger is the durable copy of the consumption
    watermark, TASK_LIFECYCLE §6.2).
    """

    def __init__(self, file_path: str) -> None:
        super().__init__()
        self._path = os.path.abspath(file_path)
        parent = os.path.dirname(self._path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self._load()

    # -- persistence -------------------------------------------------------

    def _load(self) -> None:
        """Loads (or initializes) the durable document; damage fails closed."""
        if not os.path.exists(self._path):
            self._flush()
            return
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                parsed = json.load(handle)
        except (OSError, ValueError) as error:
            raise DeliveryLedgerError(
                _REASON_CORRUPT,
                "delivery ledger file is not valid JSON: {}".format(self._path),
            ) from error
        if (
            not isinstance(parsed, dict)
            or not isinstance(parsed.get("version"), int)
            or not isinstance(parsed.get("sessions"), dict)
        ):
            raise DeliveryLedgerError(
                _REASON_CORRUPT,
                "delivery ledger file has an unrecognized shape: {}".format(self._path),
            )
        if parsed["version"] != DELIVERY_LEDGER_SCHEMA_VERSION:
            # Version strictness is SYMMETRIC with the integrity gate: there
            # is exactly one schema version — anything older or newer is a
            # damaged/foreign document and refuses to open (fail-closed).
            raise DeliveryLedgerError(
                _REASON_CORRUPT,
                "delivery ledger schema version {} is not supported by this "
                "build ({}); refusing to open (fail-closed)".format(
                    parsed["version"], DELIVERY_LEDGER_SCHEMA_VERSION
                ),
            )
        self._doc = parsed

    def _flush(self) -> None:
        """Atomic replace: tmp in the same directory, then os.replace over."""
        tmp = "{}.tmp-{}-{}".format(self._path, os.getpid(), int(time.monotonic_ns()))
        try:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(self._doc, handle, sort_keys=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self._path)
        except OSError as error:
            try:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            except OSError:  # pragma: no cover - cleanup must not mask
                pass
            raise DeliveryLedgerError(
                _REASON_UNWRITABLE,
                "failed to persist the delivery ledger at {}: delivery continues "
                "but the durable watermark is uncertain".format(self._path),
            ) from error

    # -- the reconnect gate (AC 8) -----------------------------------------

    def verify_integrity(self, session_id: str) -> None:
        """Re-reads the durable document FRESH FROM DISK; fail-closed gate.

        Called by the provider before resuming a stream after a disconnect.
        The in-memory "tracked" flag is snapshotted under the lock (the only
        shared state read here); the file itself is re-read without the
        lock — it is only ever replaced atomically by THIS process, so a
        reader sees either the old or the new document, never a partial one.

        Fail-closed conditions while the session is tracked: the file
        vanished; the durable copy is damaged or of an unexpected
        shape/version; or the durable copy no longer CONTAINS the tracked
        session (externally pruned/rewritten history — the consumption
        watermark can no longer be proven from the durable copy). The caller
        must then stop the automatic continuation (never replay from
        scratch) and surface an explicit recovery state (TASK_LIFECYCLE §6.2
        / A2A_DESIGN §9.3).
        """
        with self._lock:
            tracked = session_id in self._doc["sessions"]
        if not os.path.exists(self._path):
            if tracked:
                raise DeliveryLedgerError(
                    _REASON_CORRUPT,
                    "delivery ledger file vanished while session {!r} is tracked; "
                    "no reliable consumption watermark".format(session_id),
                )
            return
        try:
            with open(self._path, "r", encoding="utf-8") as handle:
                parsed = json.load(handle)
        except (OSError, ValueError) as error:
            raise DeliveryLedgerError(
                _REASON_CORRUPT,
                "delivery ledger file damaged while session {!r} is tracked; "
                "no reliable consumption watermark".format(session_id),
            ) from error
        if (
            not isinstance(parsed, dict)
            or parsed.get("version") != DELIVERY_LEDGER_SCHEMA_VERSION
            or not isinstance(parsed.get("sessions"), dict)
        ):
            raise DeliveryLedgerError(
                _REASON_CORRUPT,
                "delivery ledger file has an unexpected shape or version while "
                "session {!r} is tracked".format(session_id),
            )
        if tracked and session_id not in parsed["sessions"]:
            # A valid, schema-correct durable document that no longer knows
            # this session: history was externally pruned/rewritten. The
            # watermark cannot be proven against the durable copy — fail
            # closed instead of silently re-persisting the in-memory view.
            raise DeliveryLedgerError(
                _REASON_SESSION_MISSING,
                "delivery ledger no longer contains the tracked session {!r}; "
                "no reliable consumption watermark".format(session_id),
            )
