#!/usr/bin/env python3
# P0-01 (issue #79) — installation entry for the v0.9.8 TTS dual-stream
# overlay (freeze-matrix §2 patch 9) as a REPO-REBUILDABLE delivery.
#
# Composition being rebuilt (provenance in OVERLAY.md, the review record):
#   the operator-provided runtime overlay file — the vendor dual-stream TTS
#   module WITH the official v0.9.8 rework layered on, SHA-256
#   471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723 as
#   recorded on 2026-10-25 — installed at the upstream flat extension point
#   core/providers/tts/huoshan_double_stream.py (verified: upstream
#   core/utils/tts.py create_instance() loads core.providers.tts.<type> and
#   instantiates .TTSProvider; the module exists at BOTH pinned commits).
#
# Fail-closed guards (each refusal exits non-zero and writes NOTHING):
#   1. HASH PIN  — the overlay file's SHA-256 must equal the recorded pin;
#      any drift means the artifact is no longer the reviewed one.
#   2. OPT-IN    — install requires --acknowledge-undecided-selection: the
#      v0.9.7 (repo pin) vs v0.9.8 (runtime record) selection is UNDECIDED
#      (#80 owns it); replaying the overlay must stay an explicit,
#      operator-acknowledged act. This entry is NEVER wired into
#      bootstrap.sh, which keeps installing the pinned v0.9.7 baseline.
#   3. LAYOUT    — the target must carry the pinned checkout shape
#      (<target>/main/xiaozhi-server/core/providers/tts/).
#
# Semantics:
#   - install    hash-verify → backup-once (first backup wins) → copy →
#                deterministic receipt JSON (no timestamps, no abs paths);
#                idempotent (same-hash dest → verify + receipt sync only).
#   - verify-only  read-only: dest present AND hash matches the pin.
#   - rollback   restore the pre-overlay state (backup if one exists, else
#                remove a fresh install), then drop the receipt; idempotent.
#
# Usage (repo root, on the deploy host):
#   python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py \
#     --target /opt/xiaozhi-esp32-server \
#     --overlay-file /path/from/operator/backup/huoshan_double_stream.py \
#     --acknowledge-undecided-selection
#   python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py \
#     --target /opt/xiaozhi-esp32-server --verify-only
#   python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py \
#     --target /opt/xiaozhi-esp32-server --rollback
#
# The overlay file itself is NOT committed (the repo contains no vendor
# overlay files); rebuilding requires the operator's locally backed-up copy.

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

# --- machine mirror of the OVERLAY.md review record (CI keeps them in sync) --

PROVIDER_TYPE = "huoshan_double_stream"
DEST_REL = "core/providers/tts/huoshan_double_stream.py"
BACKUP_SUFFIX = ".before-overlay"
RECEIPT_NAME = "lumi-tts-overlay-receipt.json"

# Runtime-recorded overlay artifact (2026-10-25 reconciliation record):
# vendor dual-stream module + official v0.9.8 rework, operator-side copy.
RUNTIME_OVERLAY_SHA256 = "471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723"

# The repo pins v0.9.7 (deploy/xiaozhi/version.env); the overlay targets the
# v0.9.8 runtime record. Selection is UNDECIDED until #80 closes — install
# therefore demands an explicit acknowledgement, and the runtime-recorded
# result can never count as candidate acceptance by itself.
ACK_FLAG = "--acknowledge-undecided-selection"

_TAG = "[lumi-tts-overlay]"


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _server_root(target: Path) -> Path:
    return target / "main" / "xiaozhi-server"


def _dest(target: Path) -> Path:
    return _server_root(target) / DEST_REL


def _backup(target: Path) -> Path:
    return _server_root(target) / (DEST_REL + BACKUP_SUFFIX)


def _receipt(target: Path) -> Path:
    return target / RECEIPT_NAME


def _write_receipt(target: Path, installed_sha: str) -> None:
    backup_rel = DEST_REL + BACKUP_SUFFIX if _backup(target).is_file() else None
    payload = {
        "providerType": PROVIDER_TYPE,
        "pinnedSha256": RUNTIME_OVERLAY_SHA256,
        "installedSha256": installed_sha,
        "backup": backup_rel,
    }
    _receipt(target).write_text(
        json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install the hash-pinned v0.9.8 TTS dual-stream overlay into a pinned checkout"
    )
    parser.add_argument("--target", required=True, help="xiaozhi-esp32-server checkout root (bootstrap --target)")
    parser.add_argument("--overlay-file", help="operator-provided runtime overlay module (NOT committed to the repo)")
    parser.add_argument("--verify-only", action="store_true", help="verify the installed overlay hash without writing")
    parser.add_argument("--rollback", action="store_true", help="restore the pre-overlay state and drop the receipt")
    parser.add_argument(
        "--acknowledge-undecided-selection",
        action="store_true",
        help="explicit opt-in: the v0.9.7 vs v0.9.8 selection is UNDECIDED (#80); "
        "installing the overlay is an acknowledged operator act, never a default",
    )
    args = parser.parse_args()

    target = Path(args.target)
    if not _server_root(target).is_dir():
        print(f"{_TAG} pinned server root not found: {_server_root(target)}", file=sys.stderr)
        return 1

    if args.rollback:
        return _rollback(target)

    if args.verify_only:
        return _verify(target)

    if not args.acknowledge_undecided_selection:
        print(
            f"{_TAG} REFUSED: install requires {ACK_FLAG} — the v0.9.7 vs v0.9.8 "
            "selection is undecided (#80); replay must be an explicit operator act",
            file=sys.stderr,
        )
        return 2

    if not args.overlay_file:
        print(f"{_TAG} REFUSED: --overlay-file is required for install", file=sys.stderr)
        return 1
    overlay = Path(args.overlay_file)
    if not overlay.is_file():
        print(f"{_TAG} overlay file not found: {overlay}", file=sys.stderr)
        return 1

    # Guard 1 — hash pin, verified BEFORE any write (fail-closed, no touch).
    overlay_sha = sha256_of(overlay)
    if overlay_sha != RUNTIME_OVERLAY_SHA256:
        print(
            f"{_TAG} REFUSED: overlay SHA-256 {overlay_sha} does not match the recorded pin "
            f"{RUNTIME_OVERLAY_SHA256} — drift means this is not the reviewed artifact",
            file=sys.stderr,
        )
        return 1

    # Guard 3 — pinned layout (the flat upstream TTS extension point).
    tts_dir = _server_root(target) / "core" / "providers" / "tts"
    if not tts_dir.is_dir():
        print(f"{_TAG} REFUSED: upstream TTS provider directory missing: {tts_dir}", file=sys.stderr)
        return 1

    dest = _dest(target)
    if dest.is_file() and sha256_of(dest) == RUNTIME_OVERLAY_SHA256:
        # Idempotent: already the pinned artifact — sync the receipt only.
        _write_receipt(target, overlay_sha)
        print(f"{_TAG} verify: overlay already installed at {DEST_REL} (hash matches pin)")
        return 0

    # Backup-once: the FIRST pre-overlay state is the rollback point; a
    # drifted later state never overwrites the original backup.
    backup = _backup(target)
    if dest.is_file() and not backup.exists():
        shutil.copyfile(dest, backup)
        print(f"{_TAG} backed up pre-overlay state -> {DEST_REL + BACKUP_SUFFIX}")
    elif dest.is_file() and backup.exists():
        print(f"{_TAG} backup already present, keeping the original rollback point ({DEST_REL + BACKUP_SUFFIX})")

    shutil.copyfile(overlay, dest)
    _write_receipt(target, overlay_sha)
    print(f"{_TAG} installed {DEST_REL} (sha256 {overlay_sha})")
    print(f"{_TAG} receipt -> {RECEIPT_NAME} (selection undecided: adoption/replay verification stays with #81/#80)")
    return 0


def _verify(target: Path) -> int:
    dest = _dest(target)
    if not dest.is_file():
        print(f"{_TAG} VERIFY FAILED: overlay not installed at {DEST_REL}", file=sys.stderr)
        return 1
    installed = sha256_of(dest)
    if installed != RUNTIME_OVERLAY_SHA256:
        print(
            f"{_TAG} VERIFY FAILED: installed hash {installed} does not match the pin "
            f"{RUNTIME_OVERLAY_SHA256}",
            file=sys.stderr,
        )
        return 1
    print(f"{_TAG} verify: {DEST_REL} present, hash matches pin")
    return 0


def _rollback(target: Path) -> int:
    backup = _backup(target)
    dest = _dest(target)
    receipt = _receipt(target)
    if backup.is_file():
        # Pre-overlay state existed: restore it and drop the rollback bookkeeping.
        shutil.copyfile(backup, dest)
        backup.unlink()
        if receipt.is_file():
            receipt.unlink()
        print(f"{_TAG} rolled back {DEST_REL} to the pre-overlay backup")
        return 0
    if receipt.is_file():
        # Fresh install (no pre-overlay file existed): removal IS the rollback.
        # The receipt is the discriminator — a restored/foreign module with no
        # receipt is never "installed overlay" and must not be deleted.
        if dest.is_file():
            dest.unlink()
        receipt.unlink()
        print(f"{_TAG} rolled back fresh install (removed {DEST_REL} and receipt)")
        return 0
    print(f"{_TAG} nothing to roll back")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
