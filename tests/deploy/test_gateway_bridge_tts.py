"""Regression tests for the native xiaozhi chat/TTS ownership contract.

Run with standard-library unittest; no vendor credentials or services needed.
"""
import importlib.util
import queue
import sys
import threading
import time
import types
import unittest
from pathlib import Path


def load_bridge():
    logger = types.SimpleNamespace(bind=lambda **kw: logger, warning=lambda *a: None)
    # The deployment artifact imports only these two upstream surfaces.
    for name in ("config", "config.logger", "core", "core.providers", "core.providers.tts", "core.providers.tts.dto", "core.providers.tts.dto.dto"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.modules["config.logger"].setup_logging = lambda: logger
    dto = sys.modules["core.providers.tts.dto.dto"]
    dto.TTSMessageDTO = lambda **kw: types.SimpleNamespace(**kw)
    dto.SentenceType = types.SimpleNamespace(FIRST="FIRST", MIDDLE="MIDDLE", LAST="LAST")
    dto.ContentType = types.SimpleNamespace(TEXT="TEXT", ACTION="ACTION")
    path = Path(__file__).resolve().parents[2] / "deploy/xiaozhi/gateway_bridge/lumithink_llm.py"
    spec = importlib.util.spec_from_file_location("bridge_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load_bridge()


class FakeClient:
    def __init__(self, frames):
        self.frames = frames
        self.waiter = None
        self.sent = []

    def register_waiter(self, conn_id, waiter): self.waiter = waiter
    def unregister_waiter(self, conn_id): self.waiter = None
    def ensure_connected(self): pass

    def send(self, frame):
        self.sent.append(frame)
        if frame["kind"] == "turn_prompt":
            for item in self.frames:
                self.waiter.put(item)


class BridgeTTSContract(unittest.TestCase):
    def make_provider(self, frames):
        provider = bridge.LLMProvider.__new__(bridge.LLMProvider)
        conn = types.SimpleNamespace(tts=types.SimpleNamespace(tts_text_queue=queue.Queue()), sentence_id="native-turn")
        state = bridge._ConnState(conn, "conn-one")
        provider._conns = {"session-one": state}
        provider._turn_timeout_s = 2
        provider._control = types.SimpleNamespace(submit_wait=lambda fn, **kw: fn())
        provider._client = FakeClient(frames)
        return provider, state

    def test_each_sentence_is_yielded_once_without_direct_tts_enqueue(self):
        provider, state = self.make_provider([
            {"kind": "turn_started", "turnId": "gateway-turn"},
            {"kind": "tts_sentence", "text": "第一句。"},
            {"kind": "tts_sentence", "text": "第二句。"},
            {"kind": "tts_end", "reason": "completed"},
        ])
        result = list(provider.response("session-one", [{"role": "user", "content": "测试"}]))
        self.assertEqual(result, ["第一句。", "第二句。"])
        self.assertTrue(state.conn.tts.tts_text_queue.empty(), "native chat is the only queue writer")
        self.assertEqual(state.current_turn, "gateway-turn", "audio delivery finishes after text generation")
        self.assertIsNone(provider._client.waiter)

    def test_stop_flushes_audio_against_the_original_gateway_turn(self):
        provider, state = self.make_provider([])
        state.current_turn = "gateway-turn"
        state.audio_frames = 3
        provider._stop_state("session-one")
        self.assertEqual(provider._client.sent[0]["turnId"], "gateway-turn")
        self.assertEqual(provider._client.sent[0]["frames"], 3)
        self.assertIsNone(state.current_turn)

    def test_cancel_interrupts_wait_for_a_silent_gateway(self):
        provider, state = self.make_provider([])
        cancelled = threading.Event()
        timer = threading.Timer(0.05, cancelled.set)
        timer.start()
        started = time.monotonic()
        try:
            result = list(provider.response("session-one", [{"role": "user", "content": "测试"}], cancel_check=cancelled.is_set))
        finally:
            timer.join()
        self.assertEqual(result, [])
        self.assertLess(time.monotonic() - started, 0.8)
        self.assertIsNone(provider._client.waiter)


if __name__ == "__main__":
    unittest.main()
