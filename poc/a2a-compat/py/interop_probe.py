# P0-02 (issue #80) cross-SDK interop probe: official Python client
# (a2a-sdk==1.2.3) against the official JS SDK server (@a2a-js/sdk@1.3.0)
# started by ../src/interop-server.mjs.
#
# Evidence gathered (all synthetic):
#   - Agent Card resolution over the well-known path;
#   - SendStreamingMessage: SSE stream with first frame = Task, artifact
#     update frames carrying append/lastChunk on the event, terminal COMPLETED;
#   - GetTask: snapshot concatenates artifact parts in order;
#   - CancelTask on a COMPLETED task: JSON-RPC -32002 TaskNotCancelable;
#   - A2A-Version header sent by the Python client (default PROTOCOL_VERSION).
#
# Usage: python interop_probe.py <base_url>
import asyncio
import json
import sys

import httpx

from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.types import (
    CancelTaskRequest,
    GetTaskRequest,
    Message,
    Part,
    Role,
    SendMessageRequest,
    TaskState,
)


def state_name(state):
    """Enum values surface as ints in the upb build; normalize to names."""
    return state if isinstance(state, str) else TaskState.Name(state)


async def main() -> int:
    if len(sys.argv) not in (2, 3):
        print("usage: interop_probe.py <base_url> [evidence_out.json]", file=sys.stderr)
        return 2
    base_url = sys.argv[1].rstrip("/")

    evidence = {
        "lockedPythonSdk": "a2a-sdk==1.2.3",
        "lockedJsServer": "@a2a-js/sdk@1.3.0",
        "base": base_url,
        "a2aVersionHeaderSent": None,
        "streamFrames": [],
        "getTask": None,
        "cancelOnCompleted": None,
    }

    async with httpx.AsyncClient(timeout=30) as httpx_client:
        # The factory stamps A2A-Version on every request through this client.
        factory = ClientFactory(ClientConfig(httpx_client=httpx_client))
        evidence["a2aVersionHeaderSent"] = httpx_client.headers.get("A2A-Version")

        resolver = A2ACardResolver(httpx_client=httpx_client, base_url=base_url)
        card = await resolver.get_agent_card()
        iface = card.supported_interfaces[0]
        evidence["card"] = {
            "name": card.name,
            "interfaceProtocolVersion": iface.protocol_version,
            "interfaceProtocolBinding": iface.protocol_binding,
        }
        assert iface.protocol_version == "1.0", "card must declare A2A v1.0"
        client = factory.create(card)

        # 1) streaming send: consume the whole SSE-backed stream
        request = SendMessageRequest(
            message=Message(
                message_id="py-msg-1",
                role=Role.ROLE_USER,
                parts=[Part(text="你好")],
            )
        )
        task_id = None
        final_state = None
        async for response in client.send_message(request):
            frame = {"oneof": response.WhichOneof("payload")}
            payload = getattr(response, frame["oneof"])
            if frame["oneof"] == "task":
                task_id = payload.id
                frame["taskId"] = payload.id
                frame["state"] = state_name(payload.status.state)
            elif frame["oneof"] == "artifact_update":
                frame["append"] = payload.append
                frame["lastChunk"] = payload.last_chunk
                frame["artifactKeys"] = sorted(f.name for f in payload.artifact.DESCRIPTOR.fields)
                frame["hasAppendInArtifact"] = "append" in frame["artifactKeys"]
            elif frame["oneof"] == "status_update":
                frame["state"] = state_name(payload.status.state)
                final_state = state_name(payload.status.state)
            evidence["streamFrames"].append(frame)

        assert task_id, "stream must start with a Task frame"
        assert final_state == "TASK_STATE_COMPLETED", f"stream must end COMPLETED, got {final_state}"
        kinds = [f["oneof"] for f in evidence["streamFrames"]]
        assert kinds[0] == "task" and kinds[-1] == "status_update"
        updates = [f for f in evidence["streamFrames"] if f["oneof"] == "artifact_update"]
        assert len(updates) == 2
        assert updates[0]["append"] is False and updates[1]["append"] is True
        assert updates[1]["lastChunk"] is True
        assert not any(f["hasAppendInArtifact"] for f in updates), "wire artifact must not carry append/lastChunk"
        print(f"stream OK: kinds={kinds}")

        # 2) GetTask snapshot
        got = await client.get_task(GetTaskRequest(id=task_id))
        snap = got
        text = "".join(
            p.text for art in snap.artifacts for p in art.parts if p.WhichOneof("content") == "text"
        )
        assert text == "你好。我们开始吧。", f"snapshot text mismatch: {text!r}"
        assert state_name(snap.status.state) == "TASK_STATE_COMPLETED"
        evidence["getTask"] = {
            "state": state_name(snap.status.state),
            "artifactCount": len(snap.artifacts),
            "partCount": len(snap.artifacts[0].parts),
            "concatenatedText": text,
        }
        print(f"get_task OK: parts={evidence['getTask']['partCount']} text={text!r}")

        # 3) CancelTask on a terminal (COMPLETED) task → -32002
        from a2a.utils.errors import A2AError, JSON_RPC_ERROR_CODE_MAP

        try:
            await client.cancel_task(CancelTaskRequest(id=task_id))
            raise AssertionError("CancelTask on COMPLETED task must fail")
        except A2AError as err:
            # The Python SDK raises typed exception subclasses; the JSON-RPC
            # code is defined by the class-level mapping.
            code = JSON_RPC_ERROR_CODE_MAP.get(type(err))
            evidence["cancelOnCompleted"] = {
                "exception": type(err).__name__,
                "code": code,
                "message": str(err),
            }
            assert code == -32002, f"expected -32002, got {code}"
            print(f"cancel on completed OK: {type(err).__name__} → {code}")

    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    payload = json.dumps(evidence, ensure_ascii=False, indent=2, default=str)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(payload)
    print("\nPY INTEROP PROBE OK")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
