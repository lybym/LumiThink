"""Identity negatives against the REAL server (issue #115 AC 2).

无凭据/过期凭据拒绝；伪造用户字段不提权；设备主体不获得监护人私有数据 —
对照 services/a2a-server identity-service-acl 语义（ADR-0014），全部走
真实服务端（synthetic 运行时足够承载身份面）。

Zero skips; synthetic identities only; loopback only.
"""
import os
import unittest
from unittest import mock

from xiaozhi_a2a_provider.provider import (
    ProviderConfigError,
    ProviderTurnError,
    XiaozhiA2AProvider,
)

from tests.server_harness import (
    DEVICE_TOKEN,
    EXPIRED_TOKEN,
    GUARDIAN_TOKEN,
    HOUSEHOLD,
    GUARDIAN_USER,
    read_task_binding,
    raw_rpc,
    start_server,
)


def make_provider(base, token, **overrides):
    config = {"base_url": base, "turn_timeout_s": 20.0}
    config.update(overrides)
    return XiaozhiA2AProvider(config, auth_token=token)


class TestIdentityNegatives(unittest.TestCase):
    server = None

    @classmethod
    def setUpClass(cls):
        cls.server = start_server(behavior="complete", runtime_mode="synthetic")

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def test_missing_credentials_fail_closed_at_construction(self):
        env = {k: v for k, v in os.environ.items() if k != "LUMITHINK_XIAOZHI_DEVICE_TOKEN"}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ProviderConfigError) as caught:
                XiaozhiA2AProvider({"base_url": self.server.base})
        self.assertEqual(caught.exception.reason, "credential_missing")

    def test_unauthenticated_wire_request_is_401(self):
        status, body = raw_rpc(self.server.base, "GetTask", {"id": "task-never"}, token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], -32000)

    def test_expired_credential_rejected(self):
        provider = make_provider(self.server.base, EXPIRED_TOKEN)
        provider.lumi_on_hello("sess-expired")
        with self.assertRaises(ProviderTurnError) as caught:
            list(provider.response("sess-expired", [{"role": "user", "content": "你好"}]))
        self.assertEqual(caught.exception.reason, "credential_rejected")
        self.assertNotIn("你好", str(caught.exception))

    def test_forged_user_fields_never_elevate(self):
        # The device tries to CLAIM the guardian identity inside the message
        # metadata. The server binds the task to the CREDENTIAL's identity
        # (device client, client_only → household-scoped, principalless).
        forged_metadata = {
            "userId": GUARDIAN_USER,
            "householdId": HOUSEHOLD,
            "role": "guardian",
            "tenant": HOUSEHOLD,
        }
        status, body = raw_rpc(
            self.server.base, "SendMessage",
            {"message": {
                "messageId": "xz-forged-1",
                "role": "ROLE_USER",
                "parts": [{"text": "你好"}],
                "metadata": forged_metadata,
            }},
            token=DEVICE_TOKEN,
        )
        self.assertEqual(status, 200, "the request itself is accepted (visitor scope)")
        task_id = body["result"]["task"]["id"]
        binding = read_task_binding(self.server.identity_db_path, task_id)
        self.assertIsNotNone(binding)
        self.assertEqual(binding["client_id"], "xiaozhi-dev-01",
                         "the task belongs to the device client")
        self.assertIsNone(binding["principal_user_id"],
                          "forged user fields never become the principal")
        self.assertEqual(binding["household_id"], HOUSEHOLD)

    def test_device_cannot_touch_guardian_private_task(self):
        # The guardian's private conversation (bound_principal task).
        status, body = raw_rpc(
            self.server.base, "SendMessage",
            {"message": {"messageId": "xz-guardian-private-1", "role": "ROLE_USER",
                         "parts": [{"text": "监护人私有"}]}},
            token=GUARDIAN_TOKEN,
        )
        self.assertEqual(status, 200)
        guardian_task = body["result"]["task"]["id"]
        binding = read_task_binding(self.server.identity_db_path, guardian_task)
        self.assertEqual(binding["principal_user_id"], GUARDIAN_USER)

        # 设备主体 → 监护人私有查询被拒: standard TaskNotFound (-32001), the
        # task does not EXIST for the device (design §4.1, no existence leak).
        # JSON-RPC errors surface in the body (HTTP 200 per JSON-RPC-over-HTTP).
        status, body = raw_rpc(self.server.base, "GetTask", {"id": guardian_task}, token=DEVICE_TOKEN)
        self.assertEqual(body["error"]["code"], -32001)

        status, body = raw_rpc(self.server.base, "CancelTask", {"id": guardian_task}, token=DEVICE_TOKEN)
        self.assertEqual(body["error"]["code"], -32001)

        status, body = raw_rpc(self.server.base, "SubscribeToTask", {"id": guardian_task}, token=DEVICE_TOKEN)
        self.assertEqual(body["error"]["code"], -32001)

        # And the guardian's task is untouched by all of it.
        status, body = raw_rpc(self.server.base, "GetTask", {"id": guardian_task}, token=GUARDIAN_TOKEN)
        self.assertIsNone(body.get("error"))

    def test_device_credential_is_household_scoped_visitor(self):
        # The device's own turn completes in its household scope; the
        # principal column stays NULL (设备仅认证家庭, no verified user).
        provider = make_provider(self.server.base, DEVICE_TOKEN)
        session_id = "sess-visitor"
        provider.lumi_on_hello(session_id)
        texts = list(provider.response(session_id, [{"role": "user", "content": "你好"}]))
        self.assertEqual(texts, ["你好。", "我们开始吧。"])
        outcome = provider.last_outcome(session_id)
        binding = read_task_binding(self.server.identity_db_path, outcome.task_id)
        self.assertEqual(binding["client_id"], "xiaozhi-dev-01")
        self.assertIsNone(binding["principal_user_id"])


if __name__ == "__main__":
    unittest.main()
