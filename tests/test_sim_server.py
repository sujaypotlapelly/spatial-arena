import http.client
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sim_server", Path(__file__).resolve().parents[1] / "sim/server.py"
)
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)


class AppConnectionTests(unittest.TestCase):
    def setUp(self):
        self.server = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request("GET" if body is None else "POST", path,
                           body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_status_exposes_model_but_never_key(self):
        with patch.object(server_module, "API_KEY", "private-test-credential"):
            status, body = self.request("/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(body["llm"])
        self.assertNotIn("private-test-credential", json.dumps(body))

    def test_app_forwards_messages_and_keeps_reasoning_separate(self):
        provider = {"model": server_module.DEFAULT_MODEL, "choices": [{
            "finish_reason": "stop", "message": {"content": '{"route_id":"R1"}', "reasoning": "Planning"}
        }]}
        with patch.object(server_module, "API_KEY", "private-test-credential"), \
             patch.object(server_module, "log_call"), \
             patch.object(server_module.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(provider).encode())) as upstream:
            status, body = self.request("/api/chat", {"messages": [{"role": "user", "content": "Plan"}]})
        self.assertEqual(status, 200)
        self.assertEqual(body["content"], '{"route_id":"R1"}')
        self.assertEqual(body["reasoning"], "Planning")
        payload = json.loads(upstream.call_args.args[0].data)
        self.assertGreaterEqual(payload["max_tokens"], 4096)
        self.assertEqual(payload["messages"][0]["content"], "Plan")
        self.assertNotIn("private-test-credential", json.dumps(body))

    def test_missing_key_never_calls_provider(self):
        with patch.object(server_module, "API_KEY", ""), \
             patch.object(server_module.urllib.request, "urlopen") as upstream:
            status, body = self.request("/api/chat", {"messages": []})
        self.assertEqual(status, 503)
        upstream.assert_not_called()


if __name__ == "__main__":
    unittest.main()
