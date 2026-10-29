"""XiaozhiA2AProvider — the small-zhi-side A2A client adapter (P2-03, #115).

The provider turns LumiThink A2A Server tasks into the text-generator
integration face the pinned xiaozhi server already consumes from
``deploy/xiaozhi/gateway_bridge/lumithink_llm.py`` (hello registration,
``response(session_id, dialogue, cancel_check)`` yielding admitted answer
text, device abort hook), while ALL identity, task and admission semantics
stay with the LumiThink A2A Server.

Isolated package (ADR-0013 precedent): no xiaozhi-server imports, no UDS
switch, no vendor/model SDK — see tests/test_structure_redline.py.
"""

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
    "LumithinkOutputChunk",
    "PRESENTATION_CANCELED",
    "PRESENTATION_COMPLETE",
    "PRESENTATION_COMPLETED_SUPPRESSED",
    "PRESENTATION_ERROR",
    "PRESENTATION_FAILED",
    "ProviderConfigError",
    "ProviderTurnError",
    "TurnOutcome",
    "XiaozhiA2AProvider",
    "dedup_key",
    "sha256_hex",
]
