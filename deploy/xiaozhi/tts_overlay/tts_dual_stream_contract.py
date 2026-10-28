#!/usr/bin/env python3
# P0-01 (issue #79) — upstream fixture: the deployment-side official v0.9.8
# TTS dual-stream rework (matrix patch 9) as an EXECUTABLE SPECIFICATION.
#
# What this file is:
#   A scripted, hermetic reconstruction of the RECORDED semantics of the
#   v0.9.8 dual-stream session rework — 恢复双流会话 + 首个有效文本触发建会话,
#   replacing the v20 per-text-item independent sessions (machine-face record
#   §2026-10-25 基线整理说明; reconciliation item 5; freeze-matrix §2 patch 9).
#   The "vendor" is a scripted stub: no network, no credentials, no audio.
#
# Provenance (verified verbatim against the upstream repo on 2026-10-28):
#   - Interface contract: main/xiaozhi-server/core/providers/tts/base.py
#     @ 27399a2fb64b5910196f438a256ce0a9f868481f (v0.9.7 baseline; the file
#     is unchanged v0.9.7→v0.9.8 — same blob
#     34b20a626ec5a9d3cb24557a0a665df529401700) — TTSProviderBase carries the
#     async session-lifecycle hooks start_session/finish_session (pass-through
#     at base) and close(); main/xiaozhi-server/core/utils/tts.py
#     create_instance() loads the FLAT module core.providers.tts.<type> and
#     instantiates its .TTSProvider.
#   - Official v0.9.8 rework semantics:
#     core/providers/tts/huoshan_double_stream.py @
#     8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58 (blob
#     0e5c7d2e147f80574c0a9cfcc1bddcb0808dfbd1) — tts_text_priority_thread:
#     FIRST resets stream state; every TEXT item goes through text_to_speak
#     over the SAME session (send_text with conn.sentence_id); LAST triggers
#     finish_session (which flushes the sliding-window residual prefix first);
#     abort cancels (cancel_session / finish_connection) instead of finishing;
#     start_session closes a still-active prior session first
#     (activate_session guard) before opening the new one.
#
# PROVENANCE SCOPE — S1 disclosure (review P1-1, 2026-10-28):
#   The verification coverage above is NOT uniform across S1–S6, and this
#   must be read by #80 (selection matrix) and #81 (migration diffing):
#   - S2–S5 are verbatim-verified against BOTH upstream trees: the official
#     v0.9.8 source (blob 0e5c7d2e @ 8f2dda09) and the v0.9.7 baseline
#     (27399a2f — the repo pin until the 2026-10-28 D1 selection decision).
#   - S1 (lazy session creation gated on the first VALID text) is NOT
#     upstream-verifiable: BOTH pinned versions call start_session
#     UNCONDITIONALLY inside the FIRST branch (eager session creation, no
#     empty/whitespace-text gate — verified verbatim in both blobs).
#     S1 is reconstructed ONLY from the operator-side runtime record
#     (record-e2e08-machine-face.md §2026-10-25: 恢复双流会话和首个有效文本
#     触发建会话), i.e. it encodes the vendor-overlay refinement as
#     RECORDED, not vanilla upstream behavior.
#   - Consequences: #81's diffing must treat an S1 divergence from vanilla
#     upstream as the EXPECTED vendor-overlay signature, not an anomaly;
#     #80's selection matrix must not model vanilla v0.9.8 with S1's
#     empty-turn session economics (upstream opens the session at FIRST and
#     closes it at LAST regardless of text validity).
#
# What this file is NOT:
#   - NOT the vendor overlay module. The repo deliberately contains NO vendor
#     overlay files; the runtime overlay artifact stays operator-side and is
#     only hash-pinned (OVERLAY.md / install_tts_overlay.py).
#   - NOT evidence of vendor protocol behavior, device audio, A2A or real
#     machine acceptance. It pins the session-lifecycle semantics so the
#     maintenance tests (tests/deploy/test_tts_overlay_rebuild.py) and #81's
#     isolated-environment migration diffing have a hermetic executable
#     reference. The fixture is synchronous by design (no I/O in the contract).

# ---------------------------------------------------------------------------
# DTO-shaped vocabulary (mirrors core.providers.tts.dto.dto as consumed by the
# pinned commit's tts_text_priority_thread: sentence_type FIRST/TEXT/LAST and
# content_type TEXT; FILE items stay out of the recorded rework scope).
# ---------------------------------------------------------------------------

SENTENCE_FIRST = "FIRST"
SENTENCE_MIDDLE = "MIDDLE"
SENTENCE_LAST = "LAST"
CONTENT_TEXT = "TEXT"


def normalize_text(text):
    """Simplified mirror of the upstream MarkdownCleaner validity gate.

    The rework's "首个有效文本" is text that survives cleaning to a
    non-empty value. The fixture models only the essence (strip → non-empty);
    the full markdown/emoji table stays upstream-owned and out of scope here.
    """
    return (text or "").strip()


class VendorStub:
    """Scripted dual-stream vendor endpoint.

    Records protocol events as tuples so tests can assert the exact
    session-lifecycle ordering. No network, no credentials, no audio.
    Event kinds: start_connection / start_session / send_text /
    finish_session / cancel_session / close.
    """

    def __init__(self):
        self.events = []

    def start_connection(self):
        self.events.append(("start_connection",))

    def start_session(self, session_id):
        self.events.append(("start_session", session_id))

    def send_text(self, session_id, text):
        self.events.append(("send_text", session_id, text))

    def finish_session(self, session_id):
        self.events.append(("finish_session", session_id))

    def cancel_session(self, session_id):
        self.events.append(("cancel_session", session_id))

    def close(self):
        self.events.append(("close",))

    def sessions_started(self):
        return [event[1] for event in self.events if event[0] == "start_session"]

    def texts_sent(self):
        return [(event[1], event[2]) for event in self.events if event[0] == "send_text"]


class DualStreamProviderContract:
    """Executable spec of the recorded v0.9.8 dual-stream session contract.

    One instance = one provider across turns. feed() consumes one
    DTO-shaped TTS-queue item (the native chat's FIRST/TEXT/LAST stream).

    Locked semantics (OVERLAY.md §2):
      S1 lazy session creation — the FIRST item (and any empty/whitespace
         item) NEVER opens a session; the first VALID text of the turn opens
         exactly one (首个有效文本触发建会话). PROVENANCE SCOPE: this is the
         recorded vendor-overlay refinement, NOT vanilla upstream behavior —
         both pinned upstream versions open the session unconditionally at
         FIRST (see the header PROVENANCE SCOPE note);
      S2 one dual-stream session per turn — every later TEXT item of the same
         session_id reuses the open session (the v20 per-text-item independent
         session is structurally absent);
      S3 LAST closes the turn — a staged residual prefix is flushed BEFORE
         finish_session, which runs exactly once and only if a session opened
         (a turn without valid text produces no session events at all);
      S4 abort cancels — cancel_session replaces finish_session and late
         items after abort/finish are filtered, never reopening a session;
      S5 activate_session guard — when a NEW turn's session opens while a
         prior session is still active, the prior session is closed FIRST
         (close event strictly precedes the new start_session);
      S6 open boundary — replaying this contract onto a deployment stays
         gated on #80's version selection (NOT decided by this fixture).
    """

    def __init__(self, vendor=None):
        self.vendor = vendor if vendor is not None else VendorStub()
        # session_id -> {"open": bool, "finished": bool, "aborted": bool,
        #                "residual": str}
        self._turns = {}
        self._active_session = None

    # -- public contract surface -------------------------------------------
    def feed(self, session_id, sentence_type, text="", content_type=CONTENT_TEXT):
        """Consume one DTO-shaped TTS-queue item for the given turn.

        Branch order mirrors the official tts_text_priority_thread: FIRST
        resets; every non-FIRST TEXT item (including a LAST carrying a final
        chunk) sends its valid text over the session; the LAST block then
        closes the turn.
        """
        turn = self._turn(session_id)
        if turn["finished"] or turn["aborted"]:
            # Stale/late items after turn end are filtered — a finished or
            # aborted turn is never reopened (S4).
            return
        if sentence_type == SENTENCE_FIRST:
            # FIRST resets the stream state and has NO session side-effect:
            # session creation is deferred until real text arrives (S1).
            turn["residual"] = ""
            return
        valid = normalize_text(text)
        if valid and content_type == CONTENT_TEXT:
            self._ensure_session(session_id)
            self.vendor.send_text(session_id, valid)
        if sentence_type == SENTENCE_LAST:
            # LAST closes the turn: the staged residual prefix flushes BEFORE
            # the finish event (S3, mirroring official finish_session's
            # 句尾残留先发 — which is a no-op when no connection was ever
            # made, so a never-opened turn emits NO vendor events);
            # exactly once.
            residual = normalize_text(turn["residual"])
            if residual and turn["open"]:
                self.vendor.send_text(session_id, residual)
                turn["residual"] = ""
            if turn["open"]:
                self.vendor.finish_session(session_id)
                turn["open"] = False
            turn["finished"] = True
            if self._active_session == session_id:
                self._active_session = None

    def stage_residual(self, session_id, text):
        """Stage a sliding-window residual prefix (flushed by LAST).

        Mirrors the official finish_session behavior: 句尾替换词滑动窗口残留
        先发出去 (the residual is sent before the FinishSession event).
        """
        turn = self._turn(session_id)
        if turn["finished"] or turn["aborted"]:
            return
        turn["residual"] = normalize_text(text)

    def abort(self, session_id):
        """Abort the turn: cancel replaces finish; late items are filtered."""
        turn = self._turn(session_id)
        if turn["finished"] or turn["aborted"]:
            return
        if turn["open"]:
            self.vendor.cancel_session(session_id)
            turn["open"] = False
        turn["aborted"] = True
        if self._active_session == session_id:
            self._active_session = None

    # -- internal state machine ---------------------------------------------
    def _turn(self, session_id):
        if session_id not in self._turns:
            self._turns[session_id] = {
                "open": False,
                "finished": False,
                "aborted": False,
                "residual": "",
            }
        return self._turns[session_id]

    def _ensure_session(self, session_id):
        """Lazily open the turn's session (S1); enforce the S5 guard.

        Returns True when the session is open afterwards.
        """
        turn = self._turn(session_id)
        if turn["open"]:
            return True
        if self._active_session is not None and self._active_session != session_id:
            # activate_session guard: the still-active prior session is
            # closed BEFORE the new session starts (S5) — mirrors
            # start_session's `if self.activate_session: await self.close()`.
            self.vendor.close()
            self._turns[self._active_session]["open"] = False
        self.vendor.start_session(session_id)
        turn["open"] = True
        self._active_session = session_id
        return True
