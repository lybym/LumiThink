"""Full-chain isolation evidence (issue #115 AC 1): 合成设备链路.

语音轮次文本 → A2A Task 创建 → 真实 Worker 执行（dsh-worker 子进程）→
准入正文经 Provider 生成器回吐（chunkId 去重断言）→ 取消止播关联
（打断回调 → CancelTask → CANCELED + 执行停止证据）→ 断流恢复
（GetTask 快照重建 + 新订阅，不补播、断流不取消）。

The server is the REAL standalone entry in dsh-worker mode (file SQLite,
xiaozhi_device bootstrap); every assertion below is either observed through
the provider's content-free outcome surface or read cross-process from the
SQLite evidence files. Synthetic content only; loopback only; zero skips.
"""
import json
import threading
import unittest

from xiaozhi_a2a_provider.provider import (
    PRESENTATION_CANCELED,
    PRESENTATION_COMPLETE,
    ProviderTurnError,
    XiaozhiA2AProvider,
)

from tests.server_harness import (
    DEVICE_TOKEN,
    raw_rpc,
    read_executions,
    read_task_binding,
    read_task_row,
    start_server,
    wait_for,
)

CHUNK_1 = "你好。"
CHUNK_2 = "我们开始吧。"


def make_provider(base, **overrides):
    config = {"base_url": base, "turn_timeout_s": 30.0}
    config.update(overrides)
    return XiaozhiA2AProvider(config, auth_token=DEVICE_TOKEN)


class BreakAfterFirstArtifactProvider(XiaozhiA2AProvider):
    """Injects ONE transport-level SSE drop after the first artifact event.

    The wrapper only breaks the TURN stream; GetTask / SubscribeToTask /
    CancelTask go through the untouched official client, so the recovery
    protocol below runs against the REAL server with a REAL active task.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._breaker_armed = True

    def _open_official_client(self, sdk, timeout_s):
        inner = super()._open_official_client(sdk, timeout_s)
        if self._breaker_armed:
            self._breaker_armed = False
            return _BreakingClient(inner)
        return inner


class _BreakingStream:
    def __init__(self, inner):
        self._inner = inner
        self._artifact_seen = False
        self._iterator = None

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._iterator is None:
            self._iterator = self._inner.__aiter__()
        if self._artifact_seen:
            # The transport "drops" right after the first fragment — BEFORE
            # pulling any further event from the real stream.
            raise ConnectionError("synthetic sse drop after the first fragment")
        payload = await self._iterator.__anext__()
        if payload.WhichOneof("payload") == "artifact_update":
            self._artifact_seen = True
        return payload

    async def aclose(self):
        aclose = getattr(self._inner, "aclose", None)
        if aclose is not None:
            await aclose()


class _BreakingClient:
    def __init__(self, inner):
        self._inner = inner

    async def send_message(self, request):
        stream = await self._inner.send_message(request)
        return _BreakingStream(stream)

    async def get_task(self, request):
        return await self._inner.get_task(request)

    async def cancel_task(self, request):
        return await self._inner.cancel_task(request)

    async def subscribe(self, request):
        return await self._inner.subscribe(request)

    async def aclose(self):
        await self._inner.aclose()


class TestFullChain(unittest.TestCase):
    def test_voice_turn_completes_through_real_worker(self):
        server = start_server(behavior="complete", runtime_mode="dsh-worker")
        try:
            provider = make_provider(server.base)
            session_id = "sess-e2e-complete"
            provider.lumi_on_hello(session_id)
            texts = []
            for text in provider.response(session_id, [{"role": "user", "content": "讲个开头"}]):
                texts.append(text)

            # 语音轮次 → 准入正文回吐：two NEW fragments, chunkId-deduped.
            self.assertEqual(texts, [CHUNK_1, CHUNK_2])
            outcome = provider.last_outcome(session_id)
            self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)
            self.assertTrue(outcome.answer_complete)
            self.assertFalse(outcome.output_suppressed_after_cancel)
            self.assertEqual(outcome.delivered_fragments, 2)
            self.assertEqual(outcome.duplicate_fragments, 0)
            self.assertEqual(outcome.delivered_bytes, len((CHUNK_1 + CHUNK_2).encode("utf-8")))
            self.assertTrue(outcome.task_id)

            # Task 创建：REAL A2A task with the provider's stable message id.
            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "completed" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertEqual(task_row["current_state"], "completed")

            # 真实 Worker 执行：the cross-process execution row carries worker
            # registration and a real (cooperative) completion settlement.
            executions = wait_for(lambda: (
                lambda rows: rows if (rows and rows[0]["state"] == "settled"
                                      and rows[0]["worker_id"]) else None
            )(read_executions(server.task_db_path, outcome.task_id)))
            self.assertEqual(len(executions), 1)
            settlement = json.loads(executions[0]["result_json"] or "{}")
            self.assertEqual(settlement.get("outcome"), "completed")

            # 身份归属：the task binds to the DEVICE client (client_only →
            # household-scoped, principalless) — never to a forged user.
            binding = read_task_binding(server.identity_db_path, outcome.task_id)
            self.assertIsNotNone(binding)
            self.assertEqual(binding["client_id"], "xiaozhi-dev-01")
            self.assertIsNone(binding["principal_user_id"])
            self.assertEqual(binding["household_id"], "hh-xiaozhi-01")
        finally:
            server.stop()

    def test_device_interrupt_cancels_real_worker(self):
        server = start_server(behavior="stop-on-cancel", runtime_mode="dsh-worker")
        try:
            provider = make_provider(server.base)
            session_id = "sess-e2e-cancel"
            provider.lumi_on_hello(session_id)
            texts = []
            gen = provider.response(session_id, [{"role": "user", "content": "讲个故事"}])
            for text in gen:
                texts.append(text)
                signal = provider.lumi_on_abort(session_id)
                self.assertEqual(signal["status"], "cancel_intent_recorded")

            # 打断止播：only the already-played fragment; nothing after.
            self.assertEqual(texts, [CHUNK_1])
            outcome = provider.last_outcome(session_id)
            self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
            self.assertTrue(outcome.cancel_requested)
            self.assertTrue(outcome.cancel_confirmed)
            self.assertEqual(outcome.state, "TASK_STATE_CANCELED")

            # 取消止播关联（服务端证据）：the task settles CANCELED and the
            # REAL worker cooperatively stopped (own result, exit 0).
            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "canceled" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertIsNotNone(task_row)
            self.assertEqual(task_row["cancel_intent"], 1)
            executions = wait_for(lambda: (
                lambda rows: rows if (rows and rows[0]["state"] == "settled"
                                      and rows[0]["worker_id"]) else None
            )(read_executions(server.task_db_path, outcome.task_id)))
            settlement = json.loads(executions[0]["result_json"] or "{}")
            self.assertEqual(settlement.get("outcome"), "canceled")
        finally:
            server.stop()

    def test_stream_disconnect_recovers_without_cancel_or_replay(self):
        server = start_server(behavior="stop-on-cancel", runtime_mode="dsh-worker")
        try:
            provider = BreakAfterFirstArtifactProvider(
                {"base_url": server.base, "turn_timeout_s": 30.0}, auth_token=DEVICE_TOKEN
            )
            session_id = "sess-e2e-recovery"
            provider.lumi_on_hello(session_id)
            texts = []
            gen = provider.response(session_id, [{"role": "user", "content": "继续讲"}])
            aborted = {"done": False}

            for text in gen:
                texts.append(text)
                if not aborted["done"]:
                    aborted["done"] = True
                    # SSE 断开 ≠ 取消：after the drop, the task must STILL be
                    # non-terminal (no auto-cancel) — checked over real HTTP.
                    status, body = raw_rpc(
                        server.base, "GetTask",
                        {"id": provider.last_outcome(session_id).task_id},
                        token=DEVICE_TOKEN,
                    )
                    self.assertIsNone(body.get("error"))
                    state = body["result"]["status"]["state"]
                    self.assertEqual(state, "TASK_STATE_WORKING",
                                     "the transport drop must NOT cancel the task")
                    # ...then the device interrupt issues the explicit cancel.
                    signal = provider.lumi_on_abort(session_id)
                    self.assertEqual(signal["status"], "cancel_intent_recorded")

            self.assertEqual(texts, [CHUNK_1])  # no replayed prefix, no tail
            outcome = provider.last_outcome(session_id)
            self.assertTrue(outcome.disconnected)
            self.assertTrue(outcome.resubscribed)
            self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
            self.assertTrue(outcome.cancel_requested)

            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "canceled" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertIsNotNone(task_row)
            executions = read_executions(server.task_db_path, outcome.task_id)
            self.assertTrue(executions)
            self.assertEqual(json.loads(executions[0]["result_json"] or "{}").get("outcome"), "canceled")
        finally:
            server.stop()

    def test_server_unreachable_is_explicit(self):
        # 服务不可达 → explicit content-free failure with remedy semantics.
        provider = make_provider("http://127.0.0.1:9", turn_timeout_s=5.0)
        provider.lumi_on_hello("sess-unreachable")
        with self.assertRaises(ProviderTurnError) as caught:
            list(provider.response("sess-unreachable", [{"role": "user", "content": "你好"}]))
        self.assertEqual(caught.exception.reason, "server_unreachable")
        self.assertNotIn("你好", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
