#!/usr/bin/env python3
# E2E-07 (issue #57) — install the LumiThink gateway-bridge into the PINNED
# xiaozhi-esp32-server checkout.
#
# What it does (idempotent, fail-closed on drift):
#   1. copies deploy/xiaozhi/gateway_bridge/lumithink_llm.py to
#      <target>/main/xiaozhi-server/core/providers/llm/lumithink/lumithink.py
#      (the pinned commit's LLM extension point; config selects it via
#      selected_module.LLM with type "lumithink" — no other module may be
#      selected, that IS the "no built-in AI second path" enforcement);
#   2. applies the five registered fork patches (deploy/xiaozhi/fork-patches.md)
#      by replacing VERBATIM anchors from the pinned commit — each patch is
#      guarded try/except so a bridge fault never breaks the device path;
#   3. refuses to touch a checkout whose anchors do not match EXACTLY
#      (pin drift means the patch is no longer reviewed — deploy/xiaozhi/
#      version.env pins the commit; bumping it requires re-running the
#      VOICE_GATEWAY_PROTOCOL.md §3 matrix review).
#
# Usage (repo root, on the deploy host):
#   python3 deploy/xiaozhi/gateway_bridge/install_bridge.py \
#     --target /opt/xiaozhi-esp32-server \
#     [--conn-id-prefix lumithink] [--verify-only]
# CI uses the same script against the fresh bootstrap checkout.

import argparse
import shutil
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Registered fork patches (deploy/xiaozhi/fork-patches.md is the review
# record; this table is the machine-enforced mirror).
# ---------------------------------------------------------------------------

PATCHES = [
    {
        "number": "1/5",
        "name": "hello registration",
        "file": "core/handle/helloHandle.py",
        # The welcome_msg send is the LAST line of handleHelloMessage — the
        # session is live and conn.session_id minted by then.
        "anchor": "    await conn.websocket.send(json.dumps(conn.welcome_msg))\n",
        "hook_lines": [
            '    # [LumiThink E2E-07 fork patch 1/5 — gateway-bridge hello registration]',
            '    try:',
            '        _lumi_provider = getattr(conn, "llm", None)',
            '        if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_hello"):',
            '            _lumi_provider.lumi_on_hello(conn, "conn-" + str(getattr(conn, "device_id", "unknown")).replace(":", ""))',
            '    except Exception:',
            '        pass',
        ],
    },
    {
        "number": "2/5",
        "name": "abort notification",
        "file": "core/handle/abortHandle.py",
        # clearSpeakStatus is the last statement of handleAbortMessage: the
        # native client_abort handling (queue clear + tts stop) has run.
        "anchor": "    conn.clearSpeakStatus()\n",
        "hook_lines": [
            '    # [LumiThink E2E-07 fork patch 2/5 — abort (client_abort) notification]',
            '    try:',
            '        _lumi_provider = getattr(conn, "llm", None)',
            '        if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_abort"):',
            '            _lumi_provider.lumi_on_abort(conn)',
            '    except Exception:',
            '        pass',
        ],
    },
    {
        "number": "3/5",
        "name": "real audio accounting",
        "file": "core/handle/sendAudioHandle.py",
        # _do_send_audio: after the actual opus packet send + flow counters.
        "anchor": '    flow_control["packet_count"] = packet_index + 1\n    flow_control["sequence"] = sequence + 1\n',
        "hook_lines": [
            '    # [LumiThink E2E-07 fork patch 3/5 — real audio delivery accounting]',
            '    try:',
            '        _lumi_provider = getattr(conn, "llm", None)',
            '        if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_audio_frame"):',
            '            _lumi_provider.lumi_on_audio_frame(conn, opus_packet)',
            '    except Exception:',
            '        pass',
        ],
    },
    {
        "number": "4/5",
        "name": "tts stop accounting flush",
        "file": "core/handle/sendAudioHandle.py",
        # send_tts_message: after the (possibly buffered) state message send.
        "anchor": '    # 发送消息到客户端\n    await conn.websocket.send(json.dumps(message))\n',
        "hook_lines": [
            '    # [LumiThink E2E-07 fork patch 4/5 — tts-state accounting flush]',
            '    try:',
            '        _lumi_provider = getattr(conn, "llm", None)',
            '        if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_tts_state"):',
            '            _lumi_provider.lumi_on_tts_state(conn, state)',
            '    except Exception:',
            '        pass',
        ],
    },
    {
        "number": "5/5",
        "name": "device closed cleanup",
        "file": "core/connection.py",
        # _save_and_close runs in the connection finally-path: the lease and
        # the ephemeral session mapping must be released at the gateway too.
        "anchor": '    async def _save_and_close(self, ws):\n        """保存记忆并关闭连接"""\n',
        "hook_lines": [
            '        # [LumiThink E2E-07 fork patch 5/5 — device-closed cleanup]',
            '        try:',
            '            _lumi_provider = getattr(self, "llm", None)',
            '            if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_device_closed"):',
            '                _lumi_provider.lumi_on_device_closed(self)',
            '        except Exception:',
            '            pass',
        ],
    },
]

_HOOK_MARKER = "[LumiThink E2E-07 fork patch"


def main() -> int:
    parser = argparse.ArgumentParser(description="Install the LumiThink gateway bridge into the pinned checkout")
    parser.add_argument("--target", required=True, help="xiaozhi-esp32-server checkout root (bootstrap --target)")
    parser.add_argument("--verify-only", action="store_true", help="verify the module + all five patches are present without writing")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[3]
    module_src = repo_root / "deploy" / "xiaozhi" / "gateway_bridge" / "lumithink_llm.py"
    if not module_src.is_file():
        print(f"[lumi-bridge] module source not found: {module_src}", file=sys.stderr)
        return 1

    target = Path(args.target)
    server_root = target / "main" / "xiaozhi-server"
    if not server_root.is_dir():
        print(f"[lumi-bridge] pinned server root not found: {server_root}", file=sys.stderr)
        return 1

    # 1. Module install (extension point: core/utils/llm.py loads
    #    core.providers.llm.<type>.<type>.LLMProvider).
    module_dst = server_root / "core" / "providers" / "llm" / "lumithink" / "lumithink.py"
    if args.verify_only:
        if not module_dst.is_file():
            print("[lumi-bridge] VERIFY FAILED: bridge module not installed", file=sys.stderr)
            return 1
        print(f"[lumi-bridge] verify: module present {module_dst.relative_to(target)}")
    else:
        module_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(module_src, module_dst)
        print(f"[lumi-bridge] installed {module_dst.relative_to(target)}")

    # 2. Fork patches (verbatim anchors, idempotent, drift-refusing).
    failed = False
    for patch in PATCHES:
        file_path = server_root / patch["file"]
        if not file_path.is_file():
            print(f"[lumi-bridge] PATCH FAIL {patch['number']}: missing file {patch['file']}", file=sys.stderr)
            failed = True
            continue
        content = file_path.read_text(encoding="utf-8")
        hook = "\n".join(patch["hook_lines"]) + "\n"
        if patch["hook_lines"][0] in content:
            # Idempotency: this patch's own marker is present → already
            # applied. sendAudioHandle.py carries TWO patches (3/5 and
            # 4/5) — sibling markers in the same file are expected and
            # never a failure condition (anchor uniqueness below is the
            # drift guard).
            print(f"[lumi-bridge] verify: patch {patch['number']} ({patch['name']}) already applied")
            continue
        anchor = patch["anchor"]
        count = content.count(anchor)
        if count != 1:
            print(
                f"[lumi-bridge] PATCH FAIL {patch['number']} ({patch['name']}): anchor occurs {count} times "
                f"(expected exactly 1) in {patch['file']} — PIN DRIFT, refusing to patch",
                file=sys.stderr,
            )
            failed = True
            continue
        if args.verify_only:
            print(f"[lumi-bridge] VERIFY FAILED: patch {patch['number']} not applied", file=sys.stderr)
            failed = True
            continue
        replacement = anchor + hook
        # Patch 5 hooks INSIDE the async function: the anchor is a def+doc
        # block, the hook indents under it — replace with anchor + hook.
        content = content.replace(anchor, replacement, 1)
        file_path.write_text(content, encoding="utf-8")
        print(f"[lumi-bridge] applied patch {patch['number']} ({patch['name']}) -> {patch['file']}")

    if failed:
        return 1
    print("[lumi-bridge] install complete (module + 5 registered fork patches)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
