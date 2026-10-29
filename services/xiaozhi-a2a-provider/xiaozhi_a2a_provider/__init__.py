"""XiaozhiA2AProvider — the small-zhi-side A2A client adapter (P2-03, #115).

The provider turns LumiThink A2A Server tasks into the text-generator
integration face the pinned xiaozhi server already consumes from
``deploy/xiaozhi/gateway_bridge/lumithink_llm.py`` (hello registration,
``response(session_id, dialogue, cancel_check)`` yielding admitted answer
text, device abort hook), while ALL identity, task and admission semantics
stay with the LumiThink A2A Server.

P2-04 (#116) adds the channel-delivery watermark layer (A2A_DESIGN
§10.2/§10.3, TASK_LIFECYCLE §6.2): a durable consumer-side record of what
was actually delivered (``taskId + artifactId + chunkId`` + byte ranges),
per-turn delivery generations (old-turn isolation), local stop-playback
markers bound to the explicit CancelTask, a fail-closed reconnect gate, and
the read-only separation between delivery state and Task state. The
watermark layer is channel-side bookkeeping only — the server-side SQLite
store stays the single task lifecycle authority.

Isolated package (ADR-0013 precedent): no xiaozhi-server imports, no UDS
switch, no vendor/model SDK — see tests/test_structure_redline.py.
"""

from .delivery_ledger import (
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
    STOP_DEVICE_ABORT,
    STOP_DEVICE_CLOSED,
)
from .output_contract import (
    AnswerStreamAccumulator,
    ContractViolation,
    LumithinkOutputChunk,
    dedup_key,
    sha256_hex,
)
from .provider import (
    PRESENTATION_CANCELED,
    PRESENTATION_COMPLETE,
    PRESENTATION_COMPLETED_SUPPRESSED,
    PRESENTATION_ERROR,
    PRESENTATION_FAILED,
    ProviderConfigError,
    ProviderTurnError,
    TurnOutcome,
    XiaozhiA2AProvider,
)

__all__ = [
    "AnswerStreamAccumulator",
    "ContractViolation",
    "DELIVERY_LEDGER_SCHEMA_VERSION",
    "DELIVERY_STATE_COMPLETE",
    "DELIVERY_STATE_PARTIAL_STOPPED",
    "DELIVERY_STATE_UNCERTAIN",
    "DeliveryLedgerError",
    "FileDeliveryLedger",
    "LumithinkOutputChunk",
    "MemoryDeliveryLedger",
    "PRESENTATION_CANCELED",
    "PRESENTATION_COMPLETE",
    "PRESENTATION_COMPLETED_SUPPRESSED",
    "PRESENTATION_ERROR",
    "PRESENTATION_FAILED",
    "ProviderConfigError",
    "ProviderTurnError",
    "STATUS_DUPLICATE",
    "STATUS_RECORDED",
    "STATUS_STALE_GENERATION",
    "STOP_DEVICE_ABORT",
    "STOP_DEVICE_CLOSED",
    "TurnOutcome",
    "XiaozhiA2AProvider",
    "dedup_key",
    "sha256_hex",
]
