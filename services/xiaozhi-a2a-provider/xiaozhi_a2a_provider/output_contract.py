"""A2A_DESIGN §9.3/§10.1 output contract enforcement (pure stdlib).

The voice channel consumes ONLY admitted answer bodies and only NEW text:

- dedup by ``taskId + artifactId + chunkId`` — a redelivery with identical
  range and content is filtered; the same key with DIFFERENT content is a
  protocol anomaly and is never played (text-content dedup is forbidden:
  legit repeated words must survive);
- byte-range continuity: each new chunk must start exactly at the artifact's
  published watermark (UTF-8 half-open ``[startByte, endByte)``);
- the fragment SHA-256 must match the actual UTF-8 bytes;
- a published prefix may never be replaced — a replacement event (or any
  rewinding/overlapping range) is refused and recorded as a contract
  violation;
- task snapshots (GetTask) carry aggregated artifact text WITHOUT
  per-fragment metadata, so a reconnect rebuilds the boundary from the
  snapshot and only post-watermark increments are played (no automatic
  full replay);
- only artifacts whose stable artifact-level metadata marks them
  ``lumithinkContent.category == 'admitted-answer'`` are playable; anything
  else (structured data etc.) is ignored by the voice path.

Every violation is raised as a :class:`ContractViolation` with a
content-free, enumerated reason — answer text never appears in exception
messages or logs.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple

OUTPUT_METADATA_VERSION = 1
PLAYABLE_ANSWER_CATEGORY = "admitted-answer"
_SHA256_HEX_LEN = 64

# Enumerated, content-free violation reasons (stable evidence vocabulary).
REASON_BAD_OUTPUT_METADATA = "bad_output_metadata"
REASON_SHA256_MISMATCH = "sha256_mismatch"
REASON_SAME_ID_DIFFERENT_CONTENT = "same_id_different_content"
REASON_NON_CONTIGUOUS_RANGE = "non_contiguous_range"
REASON_PUBLISHED_PREFIX_REPLACEMENT = "published_prefix_replacement"
REASON_APPEND_WITHOUT_CREATION = "append_without_creation"
REASON_CHUNK_AFTER_LAST_CHUNK = "chunk_after_last_chunk"
REASON_SNAPSHOT_SHRINK = "snapshot_shrink"


class ContractViolation(Exception):
    """A §9.3 output-contract breach; the offending event is not playable."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__("output contract violation [{}]: {}".format(reason, detail))
        self.reason = reason
        self.detail = detail


def sha256_hex(text: str) -> str:
    """UTF-8 SHA-256 of a text fragment (the §9.3 content digest)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dedup_key(task_id: str, artifact_id: str, chunk_id: str) -> Tuple[str, str, str]:
    """The §9.3 dedup key — never the text content."""
    return (task_id, artifact_id, chunk_id)


@dataclass(frozen=True)
class LumithinkOutputChunk:
    """Parsed ``TaskArtifactUpdateEvent.metadata.lumithinkOutput``."""

    chunk_id: str
    start_byte: int
    end_byte: int
    sha256: str


def _as_int(value: object) -> Optional[int]:
    """JSON numbers may arrive as floats (e.g. via protobuf Struct JSON)."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def parse_output_chunk(metadata: object) -> LumithinkOutputChunk:
    """Strictly parses the ``lumithinkOutput`` event metadata (fail-closed).

    ``metadata`` is the TaskArtifactUpdateEvent metadata mapping (or None).
    Missing/malformed metadata is a contract violation: the voice channel
    never plays an unverified fragment.
    """
    if not isinstance(metadata, dict):
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "event metadata missing")
    raw = metadata.get("lumithinkOutput")
    if not isinstance(raw, dict):
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "lumithinkOutput missing")
    if _as_int(raw.get("version")) != OUTPUT_METADATA_VERSION:
        raise ContractViolation(
            REASON_BAD_OUTPUT_METADATA,
            "unsupported lumithinkOutput version: {!r}".format(raw.get("version")),
        )
    chunk_id = raw.get("chunkId")
    if not isinstance(chunk_id, str) or not chunk_id:
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "chunkId missing")
    start_byte = _as_int(raw.get("startByte"))
    end_byte = _as_int(raw.get("endByte"))
    if start_byte is None:
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "startByte not an integer")
    if end_byte is None:
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "endByte not an integer")
    if start_byte < 0 or end_byte < start_byte:
        raise ContractViolation(
            REASON_BAD_OUTPUT_METADATA,
            "invalid byte range [{}, {})".format(start_byte, end_byte),
        )
    digest = raw.get("sha256")
    if (
        not isinstance(digest, str)
        or len(digest) != _SHA256_HEX_LEN
        or any(c not in "0123456789abcdef" for c in digest)
    ):
        raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "sha256 missing or malformed")
    return LumithinkOutputChunk(
        chunk_id=chunk_id, start_byte=start_byte, end_byte=end_byte, sha256=digest
    )


def artifact_is_playable(artifact_metadata: object) -> bool:
    """True when the artifact-level metadata marks an admitted answer body."""
    if not isinstance(artifact_metadata, dict):
        return False
    content = artifact_metadata.get("lumithinkContent")
    if not isinstance(content, dict):
        return False
    return content.get("category") == PLAYABLE_ANSWER_CATEGORY


@dataclass
class IngestResult:
    """Outcome of one TaskArtifactUpdateEvent against the contract.

    For a playable NEW fragment the ``lumithinkOutput`` identity fields
    (``chunk_id``/``start_byte``/``end_byte``/``sha256``) ride along so the
    channel-delivery watermark (P2-04) can persist the delivery record
    under the §9.3 stable ids — the ledger never receives the text itself.
    """

    artifact_id: str
    playable: bool
    duplicate: bool
    new_text: str
    artifact_complete: bool
    chunk_id: str = ""
    start_byte: int = 0
    end_byte: int = 0
    sha256: str = ""


@dataclass
class _ArtifactState:
    playable: bool
    watermark: int = 0
    published: bool = False
    complete: bool = False
    seen: Dict[str, Tuple[int, int, str]] = field(default_factory=dict)


class AnswerStreamAccumulator:
    """Per-task §9.3 accumulator: dedup + continuity + digest enforcement."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self._artifacts: Dict[str, _ArtifactState] = {}
        self.violations = 0

    def _state(self, artifact_id: str, artifact_metadata: object) -> _ArtifactState:
        state = self._artifacts.get(artifact_id)
        if state is None:
            state = _ArtifactState(playable=artifact_is_playable(artifact_metadata))
            self._artifacts[artifact_id] = state
        return state

    def ingest_event(
        self,
        artifact_id: str,
        artifact_metadata: object,
        event_metadata: object,
        text: str,
        append: bool,
        last_chunk: bool,
    ) -> IngestResult:
        """Validates one artifact-update event; returns NEW text (may be '').

        Raises :class:`ContractViolation` when the event breaches the frozen
        contract — the caller must not play from a fenced stream.
        """
        if not isinstance(text, str) or not text:
            raise ContractViolation(REASON_BAD_OUTPUT_METADATA, "text part missing or empty")
        chunk = parse_output_chunk(event_metadata)
        state = self._state(artifact_id, artifact_metadata)
        if not state.playable:
            # Structured data or non-answer artifacts never reach speech.
            return IngestResult(
                artifact_id=artifact_id, playable=False, duplicate=False, new_text="",
                artifact_complete=last_chunk,
            )
        if state.complete:
            raise ContractViolation(
                REASON_CHUNK_AFTER_LAST_CHUNK,
                "artifact {} already ended".format(artifact_id),
            )
        if not state.published:
            if append:
                raise ContractViolation(
                    REASON_APPEND_WITHOUT_CREATION,
                    "first event for artifact {} must create it (append=false)".format(artifact_id),
                )
        else:
            if not append:
                raise ContractViolation(
                    REASON_PUBLISHED_PREFIX_REPLACEMENT,
                    "append=false over the published artifact {}".format(artifact_id),
                )

        seen = state.seen.get(chunk.chunk_id)
        if seen is not None:
            start, end, digest = seen
            if (start, end, digest) == (chunk.start_byte, chunk.end_byte, chunk.sha256) and (
                sha256_hex(text) == chunk.sha256
            ):
                # Honest redelivery of the same fragment: dedup, not new text.
                return IngestResult(
                    artifact_id=artifact_id, playable=True, duplicate=True, new_text="",
                    artifact_complete=last_chunk,
                    chunk_id=chunk.chunk_id, start_byte=chunk.start_byte,
                    end_byte=chunk.end_byte, sha256=chunk.sha256,
                )
            self.violations += 1
            raise ContractViolation(
                REASON_SAME_ID_DIFFERENT_CONTENT,
                "chunkId {!r} redelivered with different content".format(chunk.chunk_id),
            )

        if chunk.start_byte != state.watermark:
            self.violations += 1
            raise ContractViolation(
                REASON_NON_CONTIGUOUS_RANGE
                if chunk.start_byte > state.watermark
                else REASON_PUBLISHED_PREFIX_REPLACEMENT,
                "artifact {} expected startByte {} got {}".format(
                    artifact_id, state.watermark, chunk.start_byte
                ),
            )
        if sha256_hex(text) != chunk.sha256:
            self.violations += 1
            raise ContractViolation(
                REASON_SHA256_MISMATCH,
                "fragment digest mismatch on chunkId {!r}".format(chunk.chunk_id),
            )

        state.seen[chunk.chunk_id] = (chunk.start_byte, chunk.end_byte, chunk.sha256)
        state.watermark = chunk.end_byte
        state.published = True
        state.complete = bool(last_chunk)
        return IngestResult(
            artifact_id=artifact_id,
            playable=True,
            duplicate=False,
            new_text=text,
            artifact_complete=bool(last_chunk),
            chunk_id=chunk.chunk_id,
            start_byte=chunk.start_byte,
            end_byte=chunk.end_byte,
            sha256=chunk.sha256,
        )

    def rebuild_from_snapshot(self, artifact_id: str, artifact_metadata: object, aggregated_text: str) -> None:
        """Reconnect boundary (§9.3): the snapshot rebuilds the watermark.

        The snapshot carries aggregated artifact text WITHOUT per-fragment
        metadata, so the published prefix is marked delivered up to its UTF-8
        byte length; subsequent increments resume from there. A snapshot that
        is SHORTER than what this accumulator already played is a contract
        anomaly (the published prefix would have shrunk).
        """
        if not isinstance(aggregated_text, str):
            aggregated_text = ""
        state = self._state(artifact_id, artifact_metadata)
        snapshot_len = len(aggregated_text.encode("utf-8"))
        if state.published and snapshot_len < state.watermark:
            self.violations += 1
            raise ContractViolation(
                REASON_SNAPSHOT_SHRINK,
                "snapshot for artifact {} is shorter than the delivered prefix".format(artifact_id),
            )
        if not state.playable:
            state.playable = artifact_is_playable(artifact_metadata)
        state.watermark = max(state.watermark, snapshot_len)
        state.published = state.published or snapshot_len > 0

    def watermark_of(self, artifact_id: str) -> int:
        state = self._artifacts.get(artifact_id)
        return state.watermark if state is not None else 0

    def is_playable(self, artifact_id: str) -> bool:
        state = self._artifacts.get(artifact_id)
        return state.playable if state is not None else False
