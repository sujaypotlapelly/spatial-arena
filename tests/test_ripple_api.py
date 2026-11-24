import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


spec = importlib.util.spec_from_file_location(
    "ripple_api", Path(__file__).resolve().parents[1] / "scripts/ripple_api.py"
)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class RippleAccessTests(unittest.TestCase):
    def test_key_saved_privately_without_removing_other_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("OTHER_SETTING=keep\nOPENROUTER_API_KEY=old\n")
            key = "sk-or-v1-" + "a" * 64
            api.save_key(path, "openrouter", key)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(api.read_env(path)["OTHER_SETTING"], "keep")
            self.assertEqual(api.read_env(path)["OPENROUTER_API_KEY"], key)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)

    def test_invalid_key_and_symlink_do_not_overwrite_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "target"
            target.write_text("unchanged")
            path = Path(directory) / ".env"
            path.symlink_to(target)
            for key in ["invalid\nkey", "sk-or-v1-" + "a" * 64]:
                with self.assertRaises(ValueError):
                    api.save_key(path, "openrouter", key)
            self.assertEqual(target.read_text(), "unchanged")

    def test_environment_overrides_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text('OPENROUTER_API_KEY="file-key"\n')
            with patch.dict(os.environ, {"OPENROUTER_API_KEY": "env-key"}, clear=True):
                self.assertEqual(api.configuration(path)[-1], "env-key")

    def test_missing_key_sends_no_request(self):
        with patch.object(api.urllib.request, "build_opener") as opener:
            with self.assertRaisesRegex(ValueError, "No API key"):
                api.complete("https://openrouter.ai/api/v1", "model", "", "Hi", 16)
            opener.assert_not_called()

    def test_errors_do_not_echo_provider_body(self):
        error = urllib.error.HTTPError("https://openrouter.ai", 401, "SECRET", {}, None)
        with patch.object(api.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = error
            with self.assertRaisesRegex(ValueError, "^HTTP 401: API key rejected") as caught:
                api.complete("https://openrouter.ai/api/v1", "model", "private-key", "Hi", 16)
            self.assertNotIn("SECRET", str(caught.exception))
            self.assertEqual(opener.return_value.open.call_count, 1)

    def test_complete_answer_required(self):
        for content, finish, valid in [("Connected", "stop", True), (None, "length", False), ("Partial", "length", False)]:
            with self.subTest(content=content, finish=finish):
                response = {"choices": [{"message": {"content": content}, "finish_reason": finish}]}
                with patch.object(api.urllib.request, "build_opener") as opener:
                    import io
                    opener.return_value.open.return_value = io.StringIO(json.dumps(response))
                    if valid:
                        self.assertEqual(api.complete("https://openrouter.ai/api/v1", "model", "private-key", "Hi", 16)[1], content)
                    else:
                        with self.assertRaises(ValueError):
                            api.complete("https://openrouter.ai/api/v1", "model", "private-key", "Hi", 16)


if __name__ == "__main__":
    unittest.main()
