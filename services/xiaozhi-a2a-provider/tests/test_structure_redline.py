"""Structure red line (issue #115 AC): the provider contains NO direct
model-vendor code path — source-level check + executable assertion.

The guard AST-parses every Python file in the package and enforces:

1. an IMPORT allowlist: the standard library, the official A2A SDK stack
   (``a2a``, ``httpx``, ``google.protobuf``) — nothing else may ever be
   imported (no ASR/TTS/LLM vendor SDKs, no HTTP client besides the SDK's
   own httpx transport, no persistence layer);
2. no hardcoded model-provider endpoint constants (URL string literals are
   restricted to loopback/validation shapes and documentation hosts).
"""
import ast
import sys
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent / "xiaozhi_a2a_provider"

# The ONLY third-party import roots this package may ever touch (the
# official A2A SDK stack and the protobuf runtime it ships with).
ALLOWED_THIRD_PARTY = {"a2a", "httpx", "google"}

# Standard-library modules used by the package (informational; the check
# itself is allowlist-by-exception via sys.stdlib_module_names).
_STDLIB_ROOTS = getattr(sys, "stdlib_module_names", frozenset())

# Vendor/model endpoint markers that must never appear as URL-ish string
# constants in the package source.
BANNED_ENDPOINT_MARKERS = (
    "api.openai.com",
    "openai.azure.com",
    "api.anthropic.com",
    "api.deepseek.com",
    "ark.cn-beijing.volces.com",
    "openspeech.bytedance.com",
    "dashscope.aliyuncs.com",
    "api.coze.cn",
    "/v1/chat/completions",
    "/v1/audio",
    "sk-",  # no embedded secrets of any shape
)

ALLOWED_URL_PREFIXES = (
    "http://127.0.0.1",
    "http://localhost",
    "https://github.com/lybym/LumiThink",  # issue/doc references in comments
    "http://www.w3.org",  # XML namespaces carried by tooling defaults
)


def package_sources():
    return sorted(PACKAGE_DIR.glob("*.py"))


class TestStructureRedLine(unittest.TestCase):
    def test_package_sources_exist(self):
        sources = package_sources()
        self.assertTrue(sources, "package sources must exist for the red-line scan")

    def test_import_allowlist(self):
        violations = []
        for path in package_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                roots = []
                if isinstance(node, ast.Import):
                    roots = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    if node.level and node.level > 0:
                        continue  # intra-package relative import
                    if node.module:
                        roots = [node.module.split(".")[0]]
                for root in roots:
                    if root in _STDLIB_ROOTS or root in ALLOWED_THIRD_PARTY:
                        continue
                    violations.append("{}: import root {!r} (line {})".format(
                        path.name, root, getattr(node, "lineno", -1)))
        self.assertEqual(violations, [], "import allowlist breached:\n" + "\n".join(violations))

    def test_no_vendor_endpoint_constants_or_embedded_secrets(self):
        violations = []
        for path in package_sources():
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                    continue
                value = node.value
                for marker in BANNED_ENDPOINT_MARKERS:
                    if marker in value:
                        violations.append("{}:{} contains {!r}".format(
                            path.name, getattr(node, "lineno", -1), marker))
                if value.startswith(("http://", "https://")) and len(value) > 8:
                    # Bare scheme literals (config validation) are not URLs.
                    if not any(value.startswith(prefix) for prefix in ALLOWED_URL_PREFIXES):
                        violations.append("{}:{} non-allowlisted URL {!r}".format(
                            path.name, getattr(node, "lineno", -1), value[:80]))
        self.assertEqual(violations, [], "vendor path red line breached:\n" + "\n".join(violations))

    def test_provider_module_imports_standalone(self):
        # The core module must import with ONLY the standard library active:
        # simulate the deployment surface by blocking third-party roots.
        import importlib
        import builtins
        import sys

        source = (PACKAGE_DIR / "provider.py").read_text(encoding="utf-8")
        compile(source, "provider.py", "exec")  # syntax gate
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".")[0] in ("a2a", "httpx", "google"):
                raise ImportError("blocked for the standalone-import check: {}".format(name))
            return real_import(name, *args, **kwargs)

        saved = {
            name: sys.modules.pop(name)
            for name in ("xiaozhi_a2a_provider", "xiaozhi_a2a_provider.output_contract", "xiaozhi_a2a_provider.provider")
            if name in sys.modules
        }
        try:
            with mock_guard(guarded_import):
                module = importlib.import_module("xiaozhi_a2a_provider.provider")
                self.assertTrue(hasattr(module, "XiaozhiA2AProvider"))
        finally:
            importlib.reload(importlib.import_module("xiaozhi_a2a_provider.provider"))
            for name, module in saved.items():
                sys.modules.setdefault(name, module)

    def test_official_sdk_missing_fails_loudly(self):
        # Missing SDK must be a FATAL remedied error — never a silent skip.
        import importlib
        import builtins
        import sys

        real_import = builtins.__import__

        def no_sdk_import(name, *args, **kwargs):
            if name.split(".")[0] in ("a2a", "httpx", "google"):
                raise ImportError("No module named {!r}".format(name))
            return real_import(name, *args, **kwargs)

        saved = {
            name: sys.modules.pop(name)
            for name in ("xiaozhi_a2a_provider", "xiaozhi_a2a_provider.output_contract", "xiaozhi_a2a_provider.provider")
            if name in sys.modules
        }
        try:
            importlib.import_module("xiaozhi_a2a_provider.provider")
            with mock_guard(no_sdk_import):
                provider_module = importlib.reload(importlib.import_module("xiaozhi_a2a_provider.provider"))
                with self.assertRaises(provider_module.ProviderConfigError) as caught:
                    provider_module.XiaozhiA2AProvider(
                        {"base_url": "http://127.0.0.1:3312"}, auth_token="synthetic-token-0123456789"
                    )
                self.assertEqual(caught.exception.reason, "official_sdk_missing")
                self.assertIn("a2a-sdk==1.2.3", caught.exception.detail)
        finally:
            sys.modules.pop("xiaozhi_a2a_provider.provider", None)
            for name, module in saved.items():
                sys.modules.setdefault(name, module)
            importlib.reload(importlib.import_module("xiaozhi_a2a_provider.provider"))


class mock_guard:
    """Context manager swapping builtins.__import__ (importlib-safe)."""

    def __init__(self, replacement):
        self._replacement = replacement

    def __enter__(self):
        import builtins

        self._original = builtins.__import__
        builtins.__import__ = self._replacement
        return self

    def __exit__(self, *exc_info):
        import builtins

        builtins.__import__ = self._original
        return False


if __name__ == "__main__":
    unittest.main()
