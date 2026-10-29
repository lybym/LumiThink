"""P2-05 dual-channel runner (issue #117) — the xiaozhi channel driver.

A long-lived subprocess that drives the REAL :class:`XiaozhiA2AProvider`
(official ``a2a-sdk==1.2.3`` client inside — no fake client, no behavior
fork) against a live a2a-server on behalf of the Node-side joint spec
(``services/a2a-server/tests/p2-05-dual-channel.spec.ts``). The Node
orchestrator owns the interleaving points; this runner owns the provider
turns and reports content-free evidence back over a JSON-lines protocol:

  stdin : one JSON command per line  (``{"op": ..., ...}``)
  stdout: one JSON response per line (``{"id": <echoed id>, ...}``)
  stderr: human diagnostics (never parsed by the orchestrator)

Commands (all responses are content-free; answer text is returned ONLY in
the explicit ``text`` field of turn queries, never inside errors):

  ping                          -> {"ok": true}
  hello {session_id}            -> registers a provider session (fail-closed
                                   gate) with its own delivery-watermark
                                   ledger file under --ledger-dir
  turn_start {session_id, prompt, turn_timeout_s?}
                                -> starts the turn in a worker thread,
                                   replies immediately {"turn_id": ...}
  turn_state {turn_id}          -> non-blocking peek: {alive, done, text,
                                   error?, fragments}
  turn_wait {turn_id, timeout_s}
                                -> bounded wait, then turn_state shape
  abort {session_id}            -> provider.lumi_on_abort (device interrupt)
  device_closed {session_id}    -> provider.lumi_on_device_closed
  last_outcome {session_id}     -> content-free TurnOutcome dict | null
  delivery_summary {session_id} -> channel-delivery watermark digest | null
  raw_rpc {method, params, token?}
                                -> raw JSON-RPC POST with the device
                                   credential (default) — wire-shape evidence
  quit                          -> {"ok": true} and exit 0

ZERO-SKIP contract (same discipline as the P2-03 suite): a missing
interpreter/SDK is an explicit, remedied startup failure — never a silent
degradation. Everything is loopback + synthetic; no real credentials, no
real device data. This file intentionally contains NO provider behavior
changes: it only exercises the public integration face.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))

from xiaozhi_a2a_provider.provider import (  # noqa: E402
    ProviderConfigError,
    ProviderTurnError,
    XiaozhiA2AProvider,
)


def _fail_startup(message: str) -> "None":
    """Explicit zero-skip startup failure (the orchestrator surfaces it)."""
    sys.stderr.write("p2-05-runner startup failure: {}\n".format(message))
    sys.stderr.flush()
    sys.exit(3)


def _require_official_sdk() -> None:
    """Fails loudly when the locked official SDK is absent (zero-SKIP)."""
    try:
        import a2a.client  # noqa: F401
        import httpx  # noqa: F401
    except ImportError as error:
        _fail_startup(
            "the official A2A Python SDK is required: pip install a2a-sdk==1.2.3 "
            "({})".format(error)
        )


class _Turn:
    """Book-keeping for one in-flight provider turn."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.lock = threading.Lock()
        self.texts: list[str] = []
        self.done = False
        self.error: dict | None = None
        self.thread: threading.Thread | None = None

    def append(self, text: str) -> None:
        with self.lock:
            self.texts.append(text)

    def finish(self, error: dict | None) -> None:
        with self.lock:
            self.error = error
            self.done = True

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "session_id": self.session_id,
                "alive": not self.done,
                "done": self.done,
                "text": "".join(self.texts),
                "fragments": len(self.texts),
                "error": self.error,
            }


class _CutStream:
    """A stream wrapper that raises a transport-style loss when the cut fires.

    The G6 joint harness needs BOTH channels' OPEN SSE streams to die in the
    same orchestrated instant — INCLUDING silent parked streams that emit no
    events. The cut is therefore resolved through a loop future that the
    runner's main thread completes thread-safely; the generator races the
    next SDK event against the cut and raises exactly the failure mode the
    provider's recovery path owns (an open stream that ends without a
    terminal status → _StreamLost → snapshot rebuild + resubscribe).
    """

    def __init__(self, inner, cut: threading.Event, registry: set) -> None:
        self._inner = inner
        self._cut = cut
        self._registry = registry

    def __aiter__(self):
        return self._agen()

    async def _agen(self):
        import asyncio

        inner_iter = self._inner.__aiter__()
        loop = asyncio.get_running_loop()
        cut_future = loop.create_future()
        cut_wait = asyncio.ensure_future(self._wait_cut(cut_future))
        entry = (cut_future, loop)
        self._registry.add(entry)
        try:
            while True:
                anext_task = asyncio.ensure_future(inner_iter.__anext__())
                done, _pending = await asyncio.wait(
                    {anext_task, cut_wait}, return_when=asyncio.FIRST_COMPLETED
                )
                if cut_wait in done:
                    # The transport was severed mid-stream: kill the pending
                    # SDK read (transport-death semantics) and surface the loss.
                    anext_task.cancel()
                    raise RuntimeError("p2-05-transport-cut")
                try:
                    event = anext_task.result()
                except StopAsyncIteration:
                    return
                yield event
        finally:
            self._registry.discard(entry)
            cut_wait.cancel()

    async def _wait_cut(self, cut_future) -> bool:
        await cut_future
        return True

    async def aclose(self):
        aclose = getattr(self._inner, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except Exception:  # pragma: no cover - best effort
                pass


class _CutAwareClient:
    """Official-SDK client (one short-lived httpx context) + cut seam.

    Duck-types the provider's ``_OfficialClient`` face so it can be injected
    through ``client_factory``/``cancel_client_factory``. Non-stream calls
    (get_task/cancel_task) pass through untouched — only OPEN streams are
    severed by the cut.
    """

    def __init__(self, cut: threading.Event, registry: set, timeout_s: float, base_url: str, token: str) -> None:
        self._cut = cut
        self._registry = registry
        self._timeout_s = timeout_s
        self._base_url = base_url
        self._token = token
        self._http = None
        self._a2a = None

    async def _ensure(self):
        if self._a2a is None:
            import httpx
            from a2a.client import A2ACardResolver, ClientConfig, ClientFactory

            self._http = httpx.AsyncClient(
                timeout=self._timeout_s,
                headers={"Authorization": "Bearer {}".format(self._token)},
            )
            card = await A2ACardResolver(
                httpx_client=self._http, base_url=self._base_url
            ).get_agent_card()
            self._a2a = ClientFactory(ClientConfig(httpx_client=self._http, streaming=True)).create(card)
        return self._a2a

    async def send_message(self, request):
        a2a = await self._ensure()
        return _CutStream(a2a.send_message(request), self._cut, self._registry)

    async def get_task(self, request):
        a2a = await self._ensure()
        return await a2a.get_task(request)

    async def cancel_task(self, request):
        a2a = await self._ensure()
        return await a2a.cancel_task(request)

    async def subscribe(self, request):
        a2a = await self._ensure()
        return _CutStream(a2a.subscribe(request), self._cut, self._registry)

    async def aclose(self):
        if self._http is not None:
            try:
                await self._http.aclose()
            except Exception:  # pragma: no cover - best effort
                pass


class _Runner:
    """One provider instance per session; turn threads per turn."""

    def __init__(self, base_url: str, token: str, ledger_dir: Path) -> None:
        self._base_url = base_url
        self._token = token
        self._ledger_dir = ledger_dir
        self._ledger_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._providers: dict[str, XiaozhiA2AProvider] = {}
        self._turns: dict[str, _Turn] = {}
        self.cut_streams = threading.Event()
        self._stream_registry: set = set()

    def _provider_for(self, session_id: str) -> XiaozhiA2AProvider:
        with self._lock:
            provider = self._providers.get(session_id)
            if provider is None:
                provider = XiaozhiA2AProvider(
                    {
                        "base_url": self._base_url,
                        "delivery_ledger_path": str(
                            self._ledger_dir / "delivery-{}.json".format(session_id)
                        ),
                        "turn_timeout_s": 30.0,
                        "request_timeout_s": 30.0,
                        "cancel_timeout_s": 2.0,
                    },
                    auth_token=self._token,
                    client_factory=self._client_factory,
                )
                self._providers[session_id] = provider
            return provider

    def _client_factory(self):
        """The cut-aware official-SDK client seam (G6 transport-cut face)."""
        return _CutAwareClient(self.cut_streams, self._stream_registry, 15.0, self._base_url, self._token)

    @staticmethod
    def _resolve_cut(cut_future) -> None:
        if not cut_future.done():
            cut_future.set_result(True)

    def hello(self, session_id: str) -> dict:
        provider = self._provider_for(session_id)
        provider.lumi_on_hello(session_id)
        return {"ok": True, "session_id": session_id}

    def turn_start(self, session_id: str, prompt: str) -> dict:
        provider = self._provider_for(session_id)
        turn = _Turn(session_id)
        turn_id = "turn-{}".format(uuid.uuid4())
        with self._lock:
            self._turns[turn_id] = turn

        def run_turn() -> None:
            try:
                for text in provider.response(
                    session_id, [{"role": "user", "content": prompt}]
                ):
                    turn.append(text)
                turn.finish(None)
            except ProviderTurnError as error:
                turn.finish({"reason": error.reason, "detail": error.detail})
            except Exception as exc:  # defensive: keep the runner alive
                turn.finish({"reason": "runner_error", "detail": type(exc).__name__})

        thread = threading.Thread(target=run_turn, daemon=True, name="p2-05-turn")
        turn.thread = thread
        thread.start()
        return {"ok": True, "turn_id": turn_id}

    def _turn(self, turn_id: str) -> _Turn:
        turn = self._turns.get(turn_id)
        if turn is None:
            raise KeyError("unknown turn_id {}".format(turn_id))
        return turn

    def turn_state(self, turn_id: str) -> dict:
        return {"ok": True, "turn": self._turn(turn_id).snapshot()}

    def turn_wait(self, turn_id: str, timeout_s: float) -> dict:
        turn = self._turn(turn_id)
        deadline = time.monotonic() + max(0.0, timeout_s)
        while not turn.done and time.monotonic() < deadline:
            time.sleep(0.02)
        return {"ok": True, "turn": turn.snapshot()}

    def abort(self, session_id: str) -> dict:
        return {"ok": True, "abort": self._provider_for(session_id).lumi_on_abort(session_id)}

    def device_closed(self, session_id: str) -> dict:
        self._provider_for(session_id).lumi_on_device_closed(session_id)
        return {"ok": True}

    def last_outcome(self, session_id: str) -> dict:
        outcome = self._provider_for(session_id).last_outcome(session_id)
        if outcome is None:
            return {"ok": True, "outcome": None}
        return {"ok": True, "outcome": vars(outcome)}

    def delivery_summary(self, session_id: str) -> dict:
        summary = self._provider_for(session_id).delivery_summary(session_id)
        return {"ok": True, "summary": summary}

    def raw_rpc(self, method: str, params: dict, token: str | None) -> dict:
        headers = {"Content-Type": "application/json", "A2A-Version": "1.0"}
        headers["Authorization"] = "Bearer {}".format(token or self._token)
        request = urllib.request.Request(
            self._base_url + "/",
            data=json.dumps({"jsonrpc": "2.0", "id": "runner-raw", "method": method, "params": params}).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return {
                    "ok": True,
                    "http_status": response.status,
                    "body": json.loads(response.read().decode("utf-8")),
                }
        except urllib.error.HTTPError as error:
            return {
                "ok": True,
                "http_status": error.code,
                "body": json.loads(error.read().decode("utf-8")),
            }

    def turn_count(self) -> int:
        with self._lock:
            return len(self._turns)


def _emit(response: dict) -> None:
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    # Windows pipes decode stdin with the ANSI codepage by default; the
    # orchestrator writes UTF-8 JSON-L. Fail closed to UTF-8 on ALL three
    # streams (a mojibake prompt would poison the provider's request body).
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="P2-05 dual-channel xiaozhi runner")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--ledger-dir", required=True)
    args = parser.parse_args()

    _require_official_sdk()
    # Surface the provider's content-free INFO/WARN/ERROR diagnostics on
    # stderr (the orchestrator never parses stderr; the provider contract
    # keeps answer text out of logs).
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(levelname)s %(name)s %(message)s')
    runner = _Runner(args.base_url, args.token, Path(args.ledger_dir))
    _emit({"event": "ready", "pid": None})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            _emit({"id": None, "ok": False, "error": "bad_json_line"})
            continue
        request_id = request.get("id")
        op = request.get("op")
        try:
            if op == "ping":
                response = {"id": request_id, "ok": True, "turns": runner.turn_count()}
            elif op == "hello":
                response = {"id": request_id, **runner.hello(str(request["session_id"]))}
            elif op == "turn_start":
                response = {
                    "id": request_id,
                    **runner.turn_start(str(request["session_id"]), str(request["prompt"])),
                }
            elif op == "turn_state":
                response = {"id": request_id, **runner.turn_state(str(request["turn_id"]))}
            elif op == "turn_wait":
                response = {
                    "id": request_id,
                    **runner.turn_wait(str(request["turn_id"]), float(request.get("timeout_s", 30))),
                }
            elif op == "abort":
                response = {"id": request_id, **runner.abort(str(request["session_id"]))}
            elif op == "device_closed":
                response = {"id": request_id, **runner.device_closed(str(request["session_id"]))}
            elif op == "last_outcome":
                response = {"id": request_id, **runner.last_outcome(str(request["session_id"]))}
            elif op == "delivery_summary":
                response = {"id": request_id, **runner.delivery_summary(str(request["session_id"]))}
            elif op == "raw_rpc":
                response = {
                    "id": request_id,
                    **runner.raw_rpc(
                        str(request["method"]),
                        dict(request.get("params") or {}),
                        request.get("token"),
                    ),
                }
            elif op == "cut_streams":
                if request.get("mode") == "on":
                    runner.cut_streams.set()
                    # Resolve every live stream's cut future thread-safely so
                    # silent parked streams die immediately.
                    for cut_future, loop in list(runner._stream_registry):
                        try:
                            loop.call_soon_threadsafe(runner._resolve_cut, cut_future)
                        except RuntimeError:
                            pass  # the owning loop is already gone
                else:
                    runner.cut_streams.clear()
                response = {"id": request_id, "ok": True, "cut": runner.cut_streams.is_set()}
            elif op == "quit":
                _emit({"id": request_id, "ok": True, "bye": True})
                return 0
            else:
                response = {"id": request_id, "ok": False, "error": "unknown_op"}
        except KeyError as error:
            response = {"id": request_id, "ok": False, "error": "missing_field", "detail": str(error)}
        except ProviderConfigError as error:
            # Content-free by contract: enumerated reason + remedied detail.
            response = {"id": request_id, "ok": False, "error": "provider_config", "reason": error.reason, "detail": error.detail}
        except ProviderTurnError as error:
            # Content-free by contract: enumerated reason + no answer text.
            response = {"id": request_id, "ok": False, "error": "provider_turn", "reason": error.reason, "detail": error.detail}
        except Exception as exc:  # content-free failure surface
            response = {"id": request_id, "ok": False, "error": type(exc).__name__}
        _emit(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
