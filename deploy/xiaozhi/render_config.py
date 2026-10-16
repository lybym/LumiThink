#!/usr/bin/env python3
"""E2E-04 (issue #54): render data/.config.yaml from template + controlled env.

Fail-closed rules:
  - every ${VAR} in the template must exist in the env file and be non-empty;
  - placeholder-shaped values (<generate..., 你的...) are refused;
  - secret values are never echoed (errors name the variable, never the value);
  - output is written 0600 via a temp file + atomic replace;
  - with --owner, the output is chowned to USER[:GROUP] after the atomic
    replace (os.replace does NOT preserve the replaced file's owner, so every
    root re-render must re-apply it — otherwise the service user loses read
    access to its 0600 config and the unit crash-loops).

Usage:
  python3 render_config.py --template config/gateway-minimal.yaml \
      --env-file /etc/xiaozhi/xiaozhi.env \
      --output /opt/xiaozhi-esp32-server/main/xiaozhi-server/data/.config.yaml \
      --owner xiaozhi-server
"""

import argparse
import os
import re
import stat
import sys
import tempfile

PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
REFUSAL_MARKERS = ("<generate", "你的", "<your", "changeme", "CHANGE_ME")


def load_env_file(path):
    """Parse KEY=VALUE lines; ignore blanks and # comments; refuse duplicates."""
    values = {}
    with open(path, "r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                raise SystemExit(
                    f"[xiaozhi:render] {path}:{lineno}: expected KEY=VALUE line"
                )
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if not key:
                raise SystemExit(f"[xiaozhi:render] {path}:{lineno}: empty key")
            if key in values:
                raise SystemExit(
                    f"[xiaozhi:render] {path}:{lineno}: duplicate key {key}"
                )
            values[key] = value
    return values


def refuse_placeholder(key, value):
    lowered = value.lower()
    if any(marker.lower() in lowered for marker in REFUSAL_MARKERS):
        # Fail-closed: the operator must inject a real value, never a shape.
        raise SystemExit(
            f"[xiaozhi:render] refusing placeholder-shaped value for {key} "
            "(value withheld)"
        )


def apply_owner(path, owner):
    """Chown the rendered output to USER[:GROUP]; fail closed (non-zero exit).

    A 0600 config owned by the wrong user is an unbootable deployment (the
    service user gets EACCES), so an unsatisfiable --owner must abort the
    render. Scope note (review R2 P2-4): this covers the render itself; if
    the chown fails AFTER the atomic replace already succeeded, the rendered
    file does remain on disk with the wrong owner until the next successful
    re-render replaces it — the exit code still fails the run, but the write
    is not "never half-done".
    """
    if not owner:
        return
    # POSIX-only stdlib (deployment target is Linux); imported lazily so the
    # module stays importable on non-POSIX dev machines.
    import grp
    import pwd

    user, _, group = owner.partition(":")
    try:
        uid = pwd.getpwnam(user).pw_uid
        gid = grp.getgrnam(group).gr_gid if group else pwd.getpwnam(user).pw_gid
    except KeyError as exc:
        raise SystemExit(
            f"[xiaozhi:render] --owner {owner}: unknown user/group ({exc}); "
            "create the service user first (runbook §2 step 0)"
        )
    try:
        os.chown(path, uid, gid)
    except PermissionError:
        raise SystemExit(
            f"[xiaozhi:render] --owner {owner}: permission denied; re-run as "
            "root (a wrongly-owned 0600 config crash-loops the service)"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--template", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--owner",
        default="",
        help="USER[:GROUP] the output must belong to (root re-renders must "
        "re-apply it: os.replace does not preserve ownership)",
    )
    args = parser.parse_args()

    with open(args.template, "r", encoding="utf-8") as handle:
        template = handle.read()
    env = load_env_file(args.env_file)

    required = sorted(set(PLACEHOLDER_RE.findall(template)))
    if not required:
        raise SystemExit(
            "[xiaozhi:render] template carries no ${VAR} placeholders; "
            "refusing to render a secret-free template blindly"
        )
    missing = [name for name in required if not env.get(name)]
    if missing:
        # Names only, never values (same discipline as lib/server env checks).
        raise SystemExit(
            "[xiaozhi:render] missing/empty env keys: " + ", ".join(missing)
        )
    for name in required:
        refuse_placeholder(name, env[name])

    def substitute(match):
        return env[match.group(1)]

    rendered = PLACEHOLDER_RE.sub(substitute, template)
    leftover = PLACEHOLDER_RE.findall(rendered)
    if leftover:
        raise SystemExit(
            "[xiaozhi:render] unresolved placeholders remain: " + ", ".join(leftover)
        )

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=out_dir, prefix=".config-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(rendered)
        os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)  # 0600
        os.replace(tmp_path, args.output)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    os.chmod(args.output, stat.S_IRUSR | stat.S_IWUSR)
    apply_owner(args.output, args.owner)
    # One line, value-free: which keys were injected, nothing else.
    owner_note = f", owner={args.owner}" if args.owner else ""
    print(
        f"[xiaozhi:render] wrote {args.output} (0600{owner_note}) with keys: "
        + ", ".join(required)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
