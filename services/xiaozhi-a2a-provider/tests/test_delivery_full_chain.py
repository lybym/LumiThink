"""Real-chain delivery-watermark evidence (issue #116, real a2a-server).

真实链路（真实 a2a-server Node 子进程 + 真实 dsh-worker）覆盖 P2-04 的两个
主路径：断流重连恢复（GetTask 快照重建边界 + 持久水位去重 + 新订阅续读，
零补播）与打断竞态（本地止播标记 → 显式 CancelTask → 迟到片段被过滤，
账本部分交付记录）。全部内容合成、仅 loopback、零 SKIP。
"""
import json
import os
import shutil
import tempfile
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
    read_task_row,
    start_server,
    wait_for,
)
from tests.test_full_chain import (
    BreakAfterFirstArtifactProvider,
    CHUNK_1,
    CHUNK_2,
)


class TestDeliveryFullChain(unittest.TestCase):
    def setUp(self):
        self.ledger_dir = tempfile.mkdtemp(prefix="xz-delivery-e2e-")
        self.ledger_path = os.path.join(self.ledger_dir, "delivery-ledger.json")

    def tearDown(self):
        shutil.rmtree(self.ledger_dir, ignore_errors=True)

    def _ledger_doc(self):
        with open(self.ledger_path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def test_reconnect_recovery_restores_watermark_from_persistent_ledger(self):
        """断流 → GetTask 快照重建边界 → 新订阅续读；持久水位零补播。"""
        server = start_server(behavior="complete", runtime_mode="dsh-worker")
        try:
            provider = BreakAfterFirstArtifactProvider(
                {
                    "base_url": server.base,
                    "turn_timeout_s": 30.0,
                    "delivery_ledger_path": self.ledger_path,
                },
                auth_token=DEVICE_TOKEN,
            )
            session_id = "sess-e2e-p204-reconnect"
            provider.lumi_on_hello(session_id)
            texts = []
            for text in provider.response(session_id, [{"role": "user", "content": "继续讲"}]):
                texts.append(text)

            # 恢复续读：前缀不补播，尾部恰好一次。
            self.assertEqual(texts, [CHUNK_1, CHUNK_2])
            outcome = provider.last_outcome(session_id)
            self.assertTrue(outcome.disconnected)
            self.assertTrue(outcome.resubscribed)
            self.assertFalse(outcome.cancel_requested)
            self.assertEqual(outcome.presentation, PRESENTATION_COMPLETE)
            self.assertTrue(outcome.answer_complete)
            self.assertEqual(outcome.generation, 1)
            self.assertEqual(outcome.delivered_fragments, 2)
            self.assertEqual(outcome.duplicate_fragments, 0)

            # 持久水位账本：稳定 ID + 片段记录（AC 1）。
            doc = self._ledger_doc()
            session = doc["sessions"][session_id]
            turn = session["turns"]["1@{}".format(outcome.task_id)]
            self.assertEqual(turn["deliveredFragments"], 2)
            self.assertEqual(turn["deliveredBytes"], len((CHUNK_1 + CHUNK_2).encode("utf-8")))
            # the real server's artifact id: exactly one playable artifact body
            self.assertEqual(list(turn["artifactWatermarks"].values()), [27])
            self.assertEqual(len(turn["fragments"]), 2)
            self.assertEqual(turn["deliveryState"], "complete")
            self.assertFalse(turn["superseded"])
            # 播放完成 ≠ Task 完成：观察位与交付位分离（AC 4）。
            self.assertEqual(turn["taskStateObserved"], "TASK_STATE_COMPLETED")
            self.assertTrue(turn["answerCompleteObserved"])
            self.assertFalse(turn["outputSuppressedAfterCancelObserved"])
            # 账本内容无关纪律：永不落正文。
            with open(self.ledger_path, "rb") as handle:
                self.assertTrue(handle.read().decode("utf-8").isascii())

            # 服务端证据：任务真实完成（断流从未升级为取消）。
            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "completed" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertEqual(task_row["cancel_intent"], 0)
        finally:
            server.stop()

    def test_device_interrupt_delivery_race_records_partial_watermark(self):
        """打断×交付：本地止播标记 → CancelTask → 迟到片段被过滤 → 部分交付记录。"""
        server = start_server(behavior="stop-on-cancel", runtime_mode="dsh-worker")
        try:
            provider = XiaozhiA2AProvider(
                {
                    "base_url": server.base,
                    "turn_timeout_s": 30.0,
                    "delivery_ledger_path": self.ledger_path,
                },
                auth_token=DEVICE_TOKEN,
            )
            session_id = "sess-e2e-p204-abort"
            provider.lumi_on_hello(session_id)
            texts = []
            gen = provider.response(session_id, [{"role": "user", "content": "讲个故事"}])
            for text in gen:
                texts.append(text)
                signal = provider.lumi_on_abort(session_id)
                # 本地立即止播标记（§10.3 step 1，先于 CancelTask 生效面）。
                self.assertTrue(signal["playbackStopped"])
                outcome = provider.last_outcome(session_id)
                self.assertTrue(outcome.delivery_stopped)
                self.assertEqual(outcome.delivery_stop_reason, "device_abort")

            self.assertEqual(texts, [CHUNK_1])  # 止播后无后续交付
            outcome = provider.last_outcome(session_id)
            self.assertEqual(outcome.presentation, PRESENTATION_CANCELED)
            self.assertTrue(outcome.cancel_requested)
            self.assertTrue(outcome.cancel_confirmed)

            # 账本部分交付记录：恰 1 个片段，止播原因与交付态（AC 3）。
            doc = self._ledger_doc()
            turn = doc["sessions"][session_id]["turns"]["1@{}".format(outcome.task_id)]
            self.assertEqual(turn["deliveredFragments"], 1)
            self.assertEqual(len(turn["fragments"]), 1)
            self.assertTrue(doc["sessions"][session_id]["stopped"])
            self.assertEqual(doc["sessions"][session_id]["stopReason"], "device_abort")
            self.assertEqual(turn["deliveryState"], "partial_stopped")
            self.assertEqual(turn["taskStateObserved"], "TASK_STATE_CANCELED")

            # 服务端证据：任务 CANCELED + 取消意图 1 + 真实 worker 停止。
            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "canceled" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertEqual(task_row["cancel_intent"], 1)
        finally:
            server.stop()

    def test_damaged_ledger_fails_closed_without_replay(self):
        """账本损坏 → 无可靠水位 → 显式恢复态：不自动从头补播（fail-closed）。"""
        server = start_server(behavior="complete", runtime_mode="dsh-worker")
        try:
            provider = BreakAfterFirstArtifactProvider(
                {
                    "base_url": server.base,
                    "turn_timeout_s": 30.0,
                    "delivery_ledger_path": self.ledger_path,
                },
                auth_token=DEVICE_TOKEN,
            )
            session_id = "sess-e2e-p204-damaged"
            provider.lumi_on_hello(session_id)
            texts = []
            with self.assertRaises(ProviderTurnError) as caught:
                for text in provider.response(session_id, [{"role": "user", "content": "继续讲"}]):
                    texts.append(text)
                    # 持久账本在轮内被破坏：交付水位失去可靠依据。
                    with open(self.ledger_path, "w", encoding="utf-8") as handle:
                        handle.write("externally-corrupted-delivery-ledger")

            # 未自动从头补播：已交付前缀之外零新增文本（AC 8）。
            self.assertEqual(texts, [CHUNK_1])
            self.assertEqual(caught.exception.reason, "delivery_watermark_unreliable")
            outcome = provider.last_outcome(session_id)
            self.assertTrue(outcome.disconnected)
            # 恢复失败也绝不取消（断流 ≠ 取消；显式恢复交由上层）。
            self.assertFalse(outcome.cancel_requested)
            self.assertIsNone(outcome.cancel_confirmed)
            self.assertFalse(outcome.resubscribed)

            # fail-closed 不静默改写损坏的持久账本（人工/上层恢复入口保留）。
            with open(self.ledger_path, "r", encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "externally-corrupted-delivery-ledger")

            # 服务端证据：取消意图 0（Provider 侧从未发过 CancelTask）。
            task_row = wait_for(lambda: (
                lambda row: row if row and row["current_state"] == "completed" else None
            )(read_task_row(server.task_db_path, outcome.task_id)))
            self.assertEqual(task_row["cancel_intent"], 0)
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
