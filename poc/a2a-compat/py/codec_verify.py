# P0-02 (issue #80) isolated codec verification against the locked official
# Python SDK a2a-sdk==1.2.3 (protobuf-backed a2a.types).
#
# Mirrors the JS codec verification (../src/codec-verify.mjs) on the real
# codec path (google.protobuf.json_format.Parse / MessageToDict):
#   - docs/fixtures/a2a-v1.0/01..04 parse and re-encode round-trip;
#   - append/lastChunk belong to TaskArtifactUpdateEvent, never to Artifact;
#   - custom metadata survives the official codec;
#   - UTF-8 half-open byte ranges and per-chunk SHA-256 digests match;
#   - the two chunk events aggregate to the completed-task snapshot text;
#   - the cancel-suppressed snapshot carries the frozen result flags;
#   - no CANCELLING task state exists in the locked enum surface.
#
# Synthetic data only. No network, no services, no credentials.
#
# Environment: a2a-sdk==1.2.3 installed (pip or sha256-verified wheel unpack;
# see docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md for the locked
# version and integrity record).
import hashlib
import json
import os
import sys

from google.protobuf.json_format import MessageToDict, Parse

from a2a.types import Artifact, Role, Task, TaskArtifactUpdateEvent, TaskState

FIXTURES_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs", "fixtures", "a2a-v1.0"))


def canon(value):
    """Sort object keys recursively and drop nulls for proto3-canonical compare."""
    if isinstance(value, dict):
        return {k: canon(v) for k, v in sorted(value.items()) if v is not None}
    if isinstance(value, list):
        return [canon(v) for v in value]
    return value


def load(name):
    with open(os.path.join(FIXTURES_DIR, name), encoding="utf-8") as fh:
        return json.load(fh)


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main():
    results = []

    def record(name, detail):
        results.append({"name": name, "detail": detail})
        print(f"PASS {name} :: {detail}")

    ev01 = load("01-artifact-event.json")
    ev02 = load("02-artifact-event.json")

    # Field ownership at the descriptor level (structural fact of the SDK).
    artifact_fields = {f.name for f in Artifact.DESCRIPTOR.fields}
    event_fields = {f.name for f in TaskArtifactUpdateEvent.DESCRIPTOR.fields}
    assert "append" not in artifact_fields and "lastChunk" not in artifact_fields and "last_chunk" not in artifact_fields, artifact_fields
    assert "append" in event_fields and "last_chunk" in event_fields, event_fields
    record(
        "append/lastChunk ownership (descriptor level)",
        f"Artifact fields={sorted(artifact_fields)}; event owns append/last_chunk",
    )

    for name, raw in (("01-artifact-event.json", ev01), ("02-artifact-event.json", ev02)):
        event = Parse(json.dumps(raw), TaskArtifactUpdateEvent())
        back = MessageToDict(event)  # camelCase, proto3 default omission on

        filled = {"append": back.get("append", False), "lastChunk": back.get("lastChunk", False), **back}
        assert canon(filled) == canon(raw), f"{name} round-trip mismatch: {back}"
        if raw["append"] is False:
            assert "append" not in back, "MessageToDict omits append:false (proto3 default)"
        if raw["lastChunk"] is False:
            assert "lastChunk" not in back, "MessageToDict omits lastChunk:false (proto3 default)"
        record(f"{name} Parse/MessageToDict round-trip", "semantically equal; proto3 default omission confirmed")

        artifact = back["artifact"]
        assert "append" not in artifact and "lastChunk" not in artifact, "artifact must not carry append/lastChunk"
        record(f"{name} artifact key ownership", f"artifact keys={sorted(artifact.keys())}")

        meta = back["metadata"]["lumithinkOutput"]
        assert meta["version"] == 1 and isinstance(meta["chunkId"], str)
        record(f"{name} metadata.lumithinkOutput round-trip", f"chunkId={meta['chunkId']} range=[{meta['startByte']},{meta['endByte']})")

        text = artifact["parts"][0]["text"]
        nbytes = len(text.encode("utf-8"))
        assert meta["endByte"] - meta["startByte"] == nbytes, f"byte range must equal UTF-8 length ({name})"
        assert meta["sha256"] == sha256_hex(text), f"sha256 must match chunk text ({name})"
        record(f"{name} byte-range + sha256", f"utf8 bytes={nbytes} sha256={meta['sha256'][:16]}…")

    assert canon(ev01["artifact"]["metadata"]) == canon(ev02["artifact"]["metadata"]), "stable artifact metadata must match"
    assert ev01["artifact"]["metadata"]["lumithinkContent"]["category"] == "admitted-answer"
    record("artifact.metadata.lumithinkContent stability", "identical stable content attributes on both chunk events")

    chunk1_text = ev01["artifact"]["parts"][0]["text"]
    chunk2_text = ev02["artifact"]["parts"][0]["text"]
    full_text = chunk1_text + chunk2_text
    assert ev02["metadata"]["lumithinkOutput"]["startByte"] == len(chunk1_text.encode("utf-8"))
    assert ev02["metadata"]["lumithinkOutput"]["endByte"] == len(full_text.encode("utf-8"))
    assert (ev01["append"], ev01["lastChunk"]) == (False, False)
    assert (ev02["append"], ev02["lastChunk"]) == (True, True)
    record("append/lastChunk chunk semantics", f"fullText={full_text!r} ({len(full_text.encode('utf-8'))} utf8 bytes)")

    task03 = load("03-completed-task.json")
    task3 = Parse(json.dumps(task03), Task())
    back3 = MessageToDict(task3)
    assert canon(back3) == canon(task03), "03-completed-task.json round-trip mismatch"
    assert back3["status"]["state"] == "TASK_STATE_COMPLETED"
    assert "".join(p["text"] for p in back3["artifacts"][0]["parts"]) == full_text
    assert "append" not in back3["artifacts"][0] and "lastChunk" not in back3["artifacts"][0]
    assert back3["metadata"]["lumithinkResult"] == {"version": 1, "outputSuppressedAfterCancel": False, "answerComplete": True}
    record("03-completed-task.json round-trip", f"state=TASK_STATE_COMPLETED; lumithinkResult={back3['metadata']['lumithinkResult']}")

    task04 = load("04-completed-suppressed-task.json")
    task4 = Parse(json.dumps(task04), Task())
    back4 = MessageToDict(task4)
    assert canon(back4) == canon(task04), "04-completed-suppressed-task.json round-trip mismatch"
    assert back4["status"]["state"] == "TASK_STATE_COMPLETED", "terminal state stays COMPLETED (no custom state)"
    assert back4["status"]["message"]["role"] == "ROLE_AGENT"
    assert back4["metadata"]["lumithinkResult"] == {"version": 1, "outputSuppressedAfterCancel": True, "answerComplete": False}
    assert back4["artifacts"][0]["parts"][0]["text"] == chunk1_text
    record("04-completed-suppressed-task.json round-trip", f"lumithinkResult={back4['metadata']['lumithinkResult']}")

    state_names = [n for n, _ in TaskState.items()]
    assert "TASK_STATE_CANCELLING" not in state_names, "v1.0.1 has no CANCELLING task state"
    record("TaskState enum surface", ", ".join(state_names))

    # Role enum sanity on the locked codec.
    assert Role.Value("ROLE_AGENT") == Role.ROLE_AGENT
    print(f"\nPY CODEC VERIFY OK: {len(results)} checks passed (locked a2a-sdk==1.2.3, fixtures {FIXTURES_DIR})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
