"""REAL a2a-server integration harness for the XiaozhiA2AProvider suite.

Spawns the standalone entry (``services/a2a-server/src/main.ts``) as a real
Node subprocess — the same production entry the P1-11 probe and the P2-02
integration harness drive — with:

- the requested runtime mode (``dsh-worker`` = REAL DSH worker subprocesses
  with synthetic provider content; ``synthetic`` = parked protocol executor);
- FILE SQLite databases (task + identity) so the Python suite can read
  cross-process execution evidence (worker stop evidence, task bindings);
- a synthetic xiaozhi_device identity bootstrap (device client credential +
  guardian bound_principal credential + an EXPIRED credential for the
  identity negatives);
- loopback ephemeral port, synthetic fingerprint key, tight-but-stable
  worker watchdog tuning.

ZERO-SKIP contract: a missing Node interpreter or a server that fails to
boot is an explicit test failure with a remedy message — never a skip.
Everything is loopback + synthetic; no real credentials, no real child data.
"""
import json
import os
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent          # services/xiaozhi-a2a-provider
SERVICES_DIR = PACKAGE_DIR.parent                              # services/
SERVER_DIR = SERVICES_DIR / "a2a-server"                       # services/a2a-server
NODE_BIN_ENV = "LUMITHINK_XIAOZHI_PROVIDER_NODE_BIN"

# Synthetic credentials (never real; ≥16 chars, unique digests).
DEVICE_TOKEN = "synthetic-xiaozhi-device-token-0123456789"
GUARDIAN_TOKEN = "synthetic-guardian-credential-tok-0123456789"
EXPIRED_TOKEN = "synthetic-expired-credential-tok-0123456789"
FINGERPRINT_KEY = "p2-03-integration-synthetic-fingerprint-key"

HOUSEHOLD = "hh-xiaozhi-01"
GUARDIAN_USER = "user-guardian-x"
CHILD_USER = "user-child-x"


class HarnessError(RuntimeError):
    """A harness-level failure (environment or server boot) — always fatal."""


def _resolve_node_bin():
    candidate = os.environ.get(NODE_BIN_ENV, "").strip()
    if candidate:
        if not Path(candidate).exists():
            raise HarnessError(
                "{} points to a missing Node binary: {}".format(NODE_BIN_ENV, candidate)
            )
        return candidate
    for name in ("node.exe", "node") if os.name == "nt" else ("node",):
        found = _which(name)
        if found:
            return found
    raise HarnessError(
        "Node is required to spawn the real a2a-server; set {} or put node on PATH "
        "(zero-SKIP suite: this is a failure, not a skip)".format(NODE_BIN_ENV)
    )


def _which(name):
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = Path(directory) / name
        if candidate.is_file():
            return str(candidate)
    return None


def xiaozhi_bootstrap():
    """The synthetic two-tier directory for the device-credential face."""
    now_ms = int(time.time() * 1000)
    return {
        "households": [
            {"householdId": HOUSEHOLD, "displayName": "Synthetic xiaozhi household"},
        ],
        "users": [
            {"userId": GUARDIAN_USER, "displayName": "Synthetic guardian"},
            {"userId": CHILD_USER, "displayName": "Synthetic child"},
        ],
        "memberships": [
            {"householdId": HOUSEHOLD, "userId": GUARDIAN_USER, "role": "guardian"},
            {"householdId": HOUSEHOLD, "userId": CHILD_USER, "role": "child"},
        ],
        "relationships": [
            {"householdId": HOUSEHOLD, "guardianUserId": GUARDIAN_USER, "childUserId": CHILD_USER},
        ],
        "clients": [
            {
                # 设备仅认证家庭: a household-bound xiaozhi_device client.
                "clientId": "xiaozhi-dev-01",
                "kind": "xiaozhi_device",
                "displayName": "Synthetic xiaozhi device (household-bound)",
                "householdId": HOUSEHOLD,
            },
            {
                "clientId": "dsh-guardian-x",
                "kind": "dsh_profile",
                "displayName": "Synthetic guardian DSH profile",
            },
        ],
        "credentials": [
            {
                "credentialId": "cred-xiaozhi-device",
                "clientId": "xiaozhi-dev-01",
                "token": DEVICE_TOKEN,
                "binding": "client_only",
                "householdId": HOUSEHOLD,
            },
            {
                "credentialId": "cred-guardian-x",
                "clientId": "dsh-guardian-x",
                "token": GUARDIAN_TOKEN,
                "binding": "bound_principal",
                "principalUserId": GUARDIAN_USER,
                "householdId": HOUSEHOLD,
            },
            {
                "credentialId": "cred-expired-device",
                "clientId": "xiaozhi-dev-01",
                "token": EXPIRED_TOKEN,
                "binding": "client_only",
                "householdId": HOUSEHOLD,
                "expiresAtMs": now_ms - 60_000,
            },
        ],
        "grants": [],
    }


class StartedServer:
    """A running a2a-server subprocess + its evidence files."""

    def __init__(self, process, base, dir_path, task_db, identity_db, behavior):
        self.process = process
        self.base = base
        self.dir = dir_path
        self.task_db_path = task_db
        self.identity_db_path = identity_db
        self.behavior = behavior

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                self.process.kill()
                self.process.wait(timeout=10)
        for stream in (self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except Exception:  # pragma: no cover - best-effort cleanup
                pass


def start_server(behavior="complete", runtime_mode="dsh-worker"):
    """Boots the real server; fails loudly (never skips) on any gap."""
    if not SERVER_DIR.exists():
        raise HarnessError("a2a-server checkout not found at {}".format(SERVER_DIR))
    if not (SERVER_DIR / "node_modules").exists():
        raise HarnessError(
            "services/a2a-server dependencies missing; run `pnpm install --frozen-lockfile` "
            "in services/a2a-server (zero-SKIP suite: failure, not a skip)"
        )
    node_bin = _resolve_node_bin()
    dir_path = Path(tempfile.mkdtemp(prefix="xz-a2a-int-"))
    task_db = dir_path / "task.sqlite"
    identity_db = dir_path / "identity.sqlite"
    env = dict(os.environ)
    env.update({
        "LUMITHINK_A2A_VALIDATION_TOKEN": DEVICE_TOKEN,
        "LUMITHINK_A2A_VALIDATION_PORT": "0",
        "LUMITHINK_A2A_VALIDATION_DB": str(task_db),
        "LUMITHINK_A2A_IDENTITY_DB": str(identity_db),
        "LUMITHINK_A2A_FINGERPRINT_KEY": FINGERPRINT_KEY,
        "LUMITHINK_A2A_IDENTITY_BOOTSTRAP": json.dumps(xiaozhi_bootstrap()),
        "LUMITHINK_A2A_RUNTIME_MODE": runtime_mode,
        "LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS": "20000",
        "LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS": "4000",
        "LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS": "6000",
        "LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS": "1500",
        "LUMITHINK_A2A_WORKER_BEHAVIOR": behavior,
    })
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        [node_bin, "--experimental-strip-types", "src/main.ts"],
        cwd=str(SERVER_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
    )
    started = time.monotonic()
    stdout_lines = []
    try:
        while True:
            if process.poll() is not None:
                stderr = process.stderr.read().decode("utf-8", errors="replace")
                raise HarnessError(
                    "a2a-server exited early (code {}):\nstdout: {}\nstderr: {}".format(
                        process.returncode, "".join(stdout_lines), stderr
                    )
                )
            line = process.stdout.readline().decode("utf-8", errors="replace")
            if line:
                stdout_lines.append(line)
                marker = "listening on "
                idx = line.find(marker)
                if idx >= 0:
                    base = line[idx + len(marker):].strip().split(" ")[0]
                    return StartedServer(process, base, dir_path, task_db, identity_db, behavior)
            if time.monotonic() - started > 60:
                raise HarnessError(
                    "a2a-server did not report listening in 60s; stdout: {}".format("".join(stdout_lines))
                )
            time.sleep(0.05)
    except Exception:
        if process.poll() is None:
            process.kill()
        raise


# ---------------------------------------------------------------------------
# Cross-process evidence readers (read-only; the server owns all writes)
# ---------------------------------------------------------------------------

def _open_readonly(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(db_path), uri=True)


def read_executions(task_db_path, task_id):
    with _open_readonly(task_db_path) as db:
        rows = db.execute(
            "SELECT execution_id, task_id, state, worker_id, settled_at_ms, result_json "
            "FROM a2a_executions WHERE task_id = ?", (task_id,)
        ).fetchall()
    return [
        {"execution_id": r[0], "task_id": r[1], "state": r[2], "worker_id": r[3],
         "settled_at_ms": r[4], "result_json": r[5]}
        for r in rows
    ]


def read_task_row(task_db_path, task_id):
    with _open_readonly(task_db_path) as db:
        db.row_factory = sqlite3.Row
        row = db.execute("SELECT * FROM a2a_tasks WHERE task_id = ?", (task_id,)).fetchone()
    return dict(row) if row is not None else None


def read_task_binding(identity_db_path, task_id):
    with _open_readonly(identity_db_path) as db:
        db.row_factory = sqlite3.Row
        row = db.execute(
            "SELECT * FROM a2a_identity_task_bindings WHERE task_id = ?", (task_id,)
        ).fetchone()
    return dict(row) if row is not None else None


def wait_for(predicate, timeout_s=15.0, step_s=0.1):
    deadline = time.monotonic() + timeout_s
    while True:
        result = predicate()
        if result:
            return result
        if time.monotonic() > deadline:
            raise HarnessError("waitFor timed out after {}s".format(timeout_s))
        time.sleep(step_s)


def raw_rpc(base, method, params, token, version="1.0", timeout_s=15):
    """Raw JSON-RPC POST for wire-shape evidence (mirrors the P1-11 probe)."""
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer {}".format(token)
    if version is not None:
        headers["A2A-Version"] = version
    request = urllib.request.Request(
        base + "/",
        data=json.dumps({"jsonrpc": "2.0", "id": "raw-1", "method": method, "params": params}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))
