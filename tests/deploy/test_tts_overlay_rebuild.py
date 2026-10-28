"""Maintenance tests for the v0.9.8 TTS dual-stream overlay rebuildable
delivery (P0-01, issue #79; freeze-matrix patch 9).

Two groups, both hermetic (stdlib only; no vendor access, no credentials,
no audio, no network):
  1. installer drill   — deploy/xiaozhi/tts_overlay/install_tts_overlay.py
     hash-pin / opt-in / backup-once / idempotency / rollback / receipt
     semantics on a synthetic pinned-layout tree;
  2. contract fixtures — deploy/xiaozhi/tts_overlay/tts_dual_stream_contract.py
     locks the recorded session-lifecycle semantics (OVERLAY.md §2 S1–S6).

The REAL runtime-overlay pin (471a726c…) cannot be synthesized, so the
mechanics drills run against a monkeypatched synthetic pin; the real pin's
consistency across installer / OVERLAY.md / the 2026-10-25 reconciliation
record is asserted textually. Passing here proves the rebuildable delivery's
behavior — NOT vendor behavior, NOT device acceptance, NOT deployment
adoption (that stays with #81, selection with #80).
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import unittest
import uuid
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]

# The reconciliation-recorded runtime overlay pin (2026-10-25).
RECORDED_PIN = "471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723"


def load_module(rel_path: str, name: str):
    path = REPO_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load_module("deploy/xiaozhi/tts_overlay/install_tts_overlay.py", "lumi_tts_overlay_installer")
contract_mod = load_module("deploy/xiaozhi/tts_overlay/tts_dual_stream_contract.py", "lumi_tts_overlay_contract")

# Synthetic pin for the mechanics drills (the real artifact stays operator-side).
SYNTH_OVERLAY = b"P0-01-SYNTHETIC-OVERLAY\n"
SYNTH_PIN = hashlib.sha256(SYNTH_OVERLAY).hexdigest()
PRE_OVERLAY = b"# upstream pinned-commit placeholder module\n"

FIRST = contract_mod.SENTENCE_FIRST
LAST = contract_mod.SENTENCE_LAST


def make_tree(tmp: Path) -> Path:
    """Synthetic target with the pinned checkout shape and a pre-overlay module."""
    tts = tmp / "main" / "xiaozhi-server" / "core" / "providers" / "tts"
    tts.mkdir(parents=True, exist_ok=True)
    (tts / "huoshan_double_stream.py").write_bytes(PRE_OVERLAY)
    return tmp


def dest_of(target: Path) -> Path:
    """The installer's real destination: <target>/main/xiaozhi-server/<DEST_REL>."""
    return target / "main" / "xiaozhi-server" / installer.DEST_REL


def backup_of(target: Path) -> Path:
    return target / "main" / "xiaozhi-server" / (installer.DEST_REL + installer.BACKUP_SUFFIX)


class InstallerDrill(unittest.TestCase):
    def _run(self, target: Path, overlay=None, *flags, pin=SYNTH_PIN):
        """Drive the installer's real argparse main() through patched sys.argv."""
        import sys as _sys

        argv = ["install_tts_overlay.py", "--target", str(target)]
        if overlay is not None:
            argv += ["--overlay-file", str(overlay)]
        argv += list(flags)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(installer, "RUNTIME_OVERLAY_SHA256", pin):
            with mock.patch.object(_sys, "argv", argv):
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = installer.main()
        return code, out.getvalue(), err.getvalue()

    def _install(self, target: Path, overlay: Path):
        return self._run(target, overlay, "--acknowledge-undecided-selection")

    def _verify(self, target: Path, pin=SYNTH_PIN):
        return self._run(target, None, "--verify-only", pin=pin)

    def _rollback(self, target: Path):
        return self._run(target, None, "--rollback")

    def test_install_requires_the_undecided_selection_ack(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            code, _, err = self._run(target, overlay)  # no ack flag on purpose
            self.assertEqual(code, 2, "install without the ack flag must exit 2")
            self.assertIn("#80", err)
            self.assertEqual(dest_of(target).read_bytes(), PRE_OVERLAY, "a refused install must not change the module")
            self.assertFalse((target / installer.RECEIPT_NAME).exists(), "a refused install must not write a receipt")

    def test_install_applies_hash_pinned_overlay_with_backup_and_receipt(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            code, out, _ = self._install(target, overlay)
            self.assertEqual(code, 0)
            self.assertEqual(dest_of(target).read_bytes(), SYNTH_OVERLAY)
            self.assertEqual(backup_of(target).read_bytes(), PRE_OVERLAY, "first install must back up the pre-overlay state")
            receipt = json.loads((target / installer.RECEIPT_NAME).read_text(encoding="utf-8"))
            self.assertEqual(receipt["providerType"], "huoshan_double_stream")
            self.assertEqual(receipt["pinnedSha256"], SYNTH_PIN)
            self.assertEqual(receipt["installedSha256"], SYNTH_PIN)
            self.assertEqual(receipt["backup"], installer.DEST_REL + installer.BACKUP_SUFFIX)

    def test_reinstall_is_idempotent_and_keeps_the_original_backup(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            self.assertEqual(self._install(target, overlay)[0], 0)
            backup_before = backup_of(target).read_bytes()
            receipt_before = (target / installer.RECEIPT_NAME).read_bytes()
            code, out, _ = self._install(target, overlay)
            self.assertEqual(code, 0)
            self.assertIn("already installed", out)
            self.assertEqual(backup_of(target).read_bytes(), backup_before, "the original rollback point must never be overwritten")
            self.assertEqual((target / installer.RECEIPT_NAME).read_bytes(), receipt_before)

    def test_verify_only_passes_after_install_and_fails_without(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            code, _, _ = self._verify(target)
            self.assertEqual(code, 1, "verify-only before install must fail")
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            self.assertEqual(self._install(target, overlay)[0], 0)
            code, out, _ = self._verify(target)
            self.assertEqual(code, 0)
            self.assertIn("hash matches pin", out)

    def test_verify_only_fails_on_a_drifted_install(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            dest_of(target).write_bytes(b"drifted content\n")
            code, _, err = self._verify(target)
            self.assertEqual(code, 1)
            self.assertIn("does not match the pin", err)

    def test_hash_mismatch_refuses_without_touching_the_target(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            # The REAL recorded pin + a synthetic file: the hash guard (not
            # the opt-in guard) is what must refuse here — hence the ack flag
            # IS supplied, and the refusal still happens before any write.
            code, _, err = self._run(target, overlay, "--acknowledge-undecided-selection", pin=RECORDED_PIN)
            self.assertEqual(code, 1)
            self.assertIn("does not match the recorded pin", err)
            self.assertEqual(dest_of(target).read_bytes(), PRE_OVERLAY, "a refused install must not change the module")
            self.assertFalse((target / installer.RECEIPT_NAME).exists())

    def test_rollback_restores_the_pre_overlay_state(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            self.assertEqual(self._install(target, overlay)[0], 0)
            code, _, _ = self._rollback(target)
            self.assertEqual(code, 0)
            self.assertEqual(dest_of(target).read_bytes(), PRE_OVERLAY)
            self.assertFalse(backup_of(target).exists())
            self.assertFalse((target / installer.RECEIPT_NAME).exists())
            code, out, _ = self._rollback(target)
            self.assertEqual(code, 0, "rollback must be idempotent")
            self.assertIn("nothing to roll back", out)

    def test_rollback_of_a_fresh_install_removes_the_module(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            dest_of(target).unlink()  # no pre-overlay module
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            self.assertEqual(self._install(target, overlay)[0], 0)
            receipt = json.loads((target / installer.RECEIPT_NAME).read_text(encoding="utf-8"))
            self.assertIsNone(receipt["backup"], "a fresh install has no pre-overlay backup")
            code, out, _ = self._rollback(target)
            self.assertEqual(code, 0)
            self.assertIn("fresh install", out)
            self.assertFalse(dest_of(target).exists())
            self.assertFalse((target / installer.RECEIPT_NAME).exists())

    def test_receipt_is_deterministic_across_rebuilds(self):
        with tempfile_dir() as tmp:
            target = make_tree(tmp)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            self.assertEqual(self._install(target, overlay)[0], 0)
            first = (target / installer.RECEIPT_NAME).read_bytes()
            self.assertEqual(self._rollback(target)[0], 0)
            self.assertEqual(self._install(target, overlay)[0], 0)
            self.assertEqual((target / installer.RECEIPT_NAME).read_bytes(), first)

    def test_missing_upstream_tts_layout_refuses(self):
        with tempfile_dir() as tmp:
            target = tmp / "bare"
            (target / "main" / "xiaozhi-server").mkdir(parents=True)
            overlay = tmp / "overlay.py"
            overlay.write_bytes(SYNTH_OVERLAY)
            code, _, err = self._run(target, overlay, "--acknowledge-undecided-selection")
            self.assertEqual(code, 1)
            self.assertIn("TTS provider directory missing", err)


class RecordedPinConsistency(unittest.TestCase):
    """The machine mirror and the review record must name the same artifact."""

    def test_pin_provider_and_guard_are_consistent(self):
        installer_src = (REPO_ROOT / "deploy/xiaozhi/tts_overlay/install_tts_overlay.py").read_text(encoding="utf-8")
        overlay_doc = (REPO_ROOT / "deploy/xiaozhi/tts_overlay/OVERLAY.md").read_text(encoding="utf-8")
        self.assertIn(RECORDED_PIN, installer_src, "installer must carry the recorded runtime pin")
        self.assertIn(RECORDED_PIN, overlay_doc, "OVERLAY.md must record the same pin")
        self.assertEqual(installer.PROVIDER_TYPE, "huoshan_double_stream")
        self.assertIn(installer.PROVIDER_TYPE, overlay_doc)
        self.assertIn(installer.ACK_FLAG, installer_src)
        self.assertIn(installer.ACK_FLAG, overlay_doc)
        self.assertIn("tts_dual_stream_contract.py", overlay_doc)
        self.assertIn("test_tts_overlay_rebuild.py", overlay_doc)
        # The S1–S6 contract labels stay the shared vocabulary between the
        # fixture docstring and the review record.
        for label in ("S1", "S2", "S3", "S4", "S5", "S6"):
            self.assertIn(label, overlay_doc)
            self.assertIn(label, (REPO_ROOT / "deploy/xiaozhi/tts_overlay/tts_dual_stream_contract.py").read_text(encoding="utf-8"))


class DualStreamContractSemantics(unittest.TestCase):
    """OVERLAY.md §2 S1–S5, locked against the executable fixture."""

    def _fresh(self):
        vendor = contract_mod.VendorStub()
        return contract_mod.DualStreamProviderContract(vendor=vendor), vendor

    def test_s1_first_valid_text_opens_exactly_one_session(self):
        provider, vendor = self._fresh()
        turn = "turn-0001"
        provider.feed(turn, FIRST, text="第一句。")  # FIRST never opens a session
        self.assertEqual(vendor.events, [], "FIRST must not create a session (S1)")
        provider.feed(turn, "MIDDLE", text="第一句。")
        provider.feed(turn, "MIDDLE", text="第二句。")
        provider.feed(turn, "MIDDLE", text="第三句。")
        self.assertEqual(vendor.sessions_started(), [turn], "exactly one session per turn (S2)")
        self.assertEqual([sid for sid, _ in vendor.texts_sent()], [turn, turn, turn])
        self.assertEqual([txt for *_, txt in vendor.texts_sent()], ["第一句。", "第二句。", "第三句。"])

    def test_s1_whitespace_and_markdown_only_items_never_open_a_session(self):
        provider, vendor = self._fresh()
        turn = "turn-0002"
        provider.feed(turn, FIRST, text="   ")
        provider.feed(turn, "MIDDLE", text="")
        provider.feed(turn, "MIDDLE", text="　")  # full-width space
        self.assertEqual(vendor.events, [], "no valid text → no session events at all (S1/S3)")

    def test_s3_last_finishes_once_only_if_a_session_opened(self):
        provider, vendor = self._fresh()
        turn = "turn-0003"
        provider.feed(turn, LAST, text="只有结尾。")
        self.assertEqual(
            [e[0] for e in vendor.events], ["start_session", "send_text", "finish_session"],
            "LAST with valid text opens lazily, sends, then finishes once",
        )
        provider2, vendor2 = self._fresh()
        provider2.feed("turn-0004", LAST, text="   ")
        self.assertEqual(vendor2.events, [], "a turn without valid text produces no finish (S3)")

    def test_s3_residual_prefix_is_flushed_before_finish(self):
        provider, vendor = self._fresh()
        turn = "turn-0005"
        provider.feed(turn, "MIDDLE", text="前半。")
        provider.stage_residual(turn, "残留")
        provider.feed(turn, LAST, text="")  # LAST closes the turn
        kinds = [e[0] for e in vendor.events]
        self.assertLess(kinds.index("send_text"), kinds.index("finish_session"))
        self.assertEqual(kinds[-1], "finish_session")
        self.assertEqual(vendor.texts_sent()[-1][1], "残留")

    def test_s3_residual_on_a_never_opened_turn_emits_nothing(self):
        provider, vendor = self._fresh()
        turn = "turn-0005b"
        provider.stage_residual(turn, "无主残留")  # no text ever opened a session
        provider.feed(turn, LAST, text="")
        self.assertEqual(vendor.events, [], "no connection was ever made: nothing flushes (S3)")

    def test_s4_abort_cancels_instead_of_finishing_and_filters_late_items(self):
        provider, vendor = self._fresh()
        turn = "turn-0006"
        provider.feed(turn, "MIDDLE", text="被打断的一句。")
        provider.abort(turn)
        kinds = [e[0] for e in vendor.events]
        self.assertIn("cancel_session", kinds)
        self.assertNotIn("finish_session", kinds, "abort replaces finish (S4)")
        provider.feed(turn, "MIDDLE", text="迟到的句子。")
        provider.feed(turn, LAST, text="迟到的收尾。")
        self.assertNotIn((turn, "迟到的句子。"), vendor.texts_sent())
        self.assertEqual(kinds.count("cancel_session"), 1, "late items never reopen or re-cancel (S4)")

    def test_s5_new_turn_closes_the_active_session_before_starting(self):
        provider, vendor = self._fresh()
        provider.feed("turn-0007", "MIDDLE", text="第一轮。")
        provider.feed("turn-0008", "MIDDLE", text="第二轮。")
        events = vendor.events
        close_index = events.index(("close",))
        new_start_index = events.index(("start_session", "turn-0008"))
        self.assertLess(close_index, new_start_index, "the S5 guard closes the prior session FIRST")
        self.assertEqual(vendor.sessions_started(), ["turn-0007", "turn-0008"])

    def test_s5_finished_turn_does_not_demand_a_close(self):
        provider, vendor = self._fresh()
        provider.feed("turn-0009", LAST, text="完整收尾。")
        self.assertNotIn(("close",), vendor.events, "a finished session needs no guard close (S5)")
        provider.feed("turn-0010", "MIDDLE", text="下一轮。")
        self.assertNotIn(("close",), vendor.events)


class tempfile_dir:
    """Scratch directory, removed best-effort.

    Prefers the platform temp area (Linux CI behavior); if nested mkdir is
    denied there (Windows file-sandbox quirk in this dev environment), the
    drill falls back to a scratch root beside the repo checkout. Removal is
    best-effort so a cleanup quirk can never fail a drill that already
    verified its state.
    """

    NESTED = ("main", "xiaozhi-server", "core", "providers", "tts")

    def __enter__(self):
        import os
        import shutil
        import tempfile

        self._shutil = shutil
        try:
            base = Path(tempfile.mkdtemp(prefix="lumi-tts-drill-"))
            os.makedirs(base.joinpath(*self.NESTED), exist_ok=True)
        except OSError:
            if base is not None:
                self._shutil.rmtree(base, ignore_errors=True)
            base = Path(os.path.join(REPO_ROOT.parent, "_scratch", "test-tts-overlay", uuid.uuid4().hex))
            os.makedirs(base.joinpath(*self.NESTED))
        self._path = base
        return base

    def __exit__(self, *exc):
        self._shutil.rmtree(self._path, ignore_errors=True)
        return False


if __name__ == "__main__":
    unittest.main()
