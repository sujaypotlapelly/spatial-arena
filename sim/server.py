#!/usr/bin/env python3
"""Static server for the simulation plus a small OpenRouter proxy.

The API key stays on this machine; the browser only talks to /api/*.
Every model call is appended to runs/sim/<date>.jsonl (ignored by Git).

    OPENROUTER_API_KEY=... python3 sim/server.py      # http://localhost:8000

Without a key the page still runs, using the labelled offline heuristic.
Standard library only.
"""

import datetime as dt
import json
import os
import random
import sys
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SIM_DIR = Path(__file__).resolve().parent
REPO = SIM_DIR.parent
RUNS = REPO / "runs" / "sim"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "ricursiveai/ripple-65b-preview"


def load_env():
    for path in (REPO / ".env", SIM_DIR / ".env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_env()
API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
MODEL = os.environ.get("RIPPLE_MODEL", DEFAULT_MODEL)
MAX_TOKENS = int(os.environ.get("RIPPLE_MAX_TOKENS", "32768"))
RETRIES = int(os.environ.get("RIPPLE_RETRIES", "3"))
TIMEOUT = int(os.environ.get("RIPPLE_TIMEOUT", "180"))


def log_call(record):
    RUNS.mkdir(parents=True, exist_ok=True)
    path = RUNS / f"{dt.date.today().isoformat()}.jsonl"
    with path.open("a") as f:
        f.write(json.dumps(record) + "\n")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SIM_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/" in (str(args[0]) if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/status":
            return self.send_json(200, {"llm": bool(API_KEY), "model": MODEL})
        return super().do_GET()

    def save_session(self, session):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        out = REPO / "runs" / "arena" / stamp
        out.mkdir(parents=True, exist_ok=True)
        (out / "session.json").write_text(json.dumps(session))
        episodes = []
        if session.get("baseline"):
            episodes.append(session["baseline"])
        episodes += session.get("training") or []
        if session.get("evaluation"):
            episodes += session["evaluation"].get("episodes") or []
        with (out / "episodes.jsonl").open("w") as f:
            for ep in episodes:
                f.write(json.dumps(ep) + "\n")
        ev = session.get("evaluation") or {}
        metrics = {
            "exportedAt": session.get("exportedAt"),
            "usingModel": session.get("usingModel"),
            "model": MODEL if session.get("usingModel") else None,
            "strategy": session.get("strategy"),
            "metrics": ev.get("metrics"),
            "quiz": {k: {kk: vv for kk, vv in (v or {}).items() if kk != "reply"} for k, v in ((ev.get("quiz") or {}).get("results") or {}).items()},
            "ledger": session.get("ledger"),
        }
        (out / "metrics.json").write_text(json.dumps(metrics, indent=2))
        return out

    def do_POST(self):
        if self.path == "/api/save":
            length = int(self.headers.get("Content-Length", 0))
            try:
                out = self.save_session(json.loads(self.rfile.read(length)))
            except Exception as exc:  # noqa: BLE001
                return self.send_json(400, {"error": str(exc)})
            return self.send_json(200, {"ok": True, "dir": str(out.relative_to(REPO))})
        if self.path == "/api/log":
            length = int(self.headers.get("Content-Length", 0))
            try:
                log_call({"ts": time.time(), "kind": "round", **json.loads(self.rfile.read(length))})
            except Exception as exc:  # noqa: BLE001
                return self.send_json(400, {"error": str(exc)})
            return self.send_json(200, {"ok": True})
        if self.path != "/api/chat":
            return self.send_json(404, {"error": "not found"})
        if not API_KEY:
            return self.send_json(503, {"error": "OPENROUTER_API_KEY is not set on the server"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(length))
            messages = req["messages"]
        except Exception as exc:  # noqa: BLE001
            return self.send_json(400, {"error": f"bad request: {exc}"})
        tag = str(req.get("tag", ""))[:40]
        payload = {
            "model": MODEL,
            "messages": messages,
            "temperature": float(req.get("temperature", 0.7)),
            "max_tokens": min(int(req.get("max_tokens") or MAX_TOKENS), 32768),
        }
        # Harness options, passed through to OpenRouter: which Ripple hosts to
        # use, whether it thinks first, and tools it may call.
        prov = req.get("provider")
        if isinstance(prov, dict):
            payload["provider"] = {k: prov[k] for k in ("order", "allow_fallbacks", "only", "ignore") if k in prov}
        if isinstance(req.get("reasoning"), dict):
            payload["reasoning"] = req["reasoning"]
        if isinstance(req.get("tools"), list):
            payload["tools"] = req["tools"]
            if req.get("tool_choice"):
                payload["tool_choice"] = req["tool_choice"]
        t0 = time.time()
        # Hosted Ripple is shared with other users: retry rate limits and
        # host errors with backoff, and re-ask once (asking for the answer
        # only) when a reply is cut off mid-reasoning. Every attempt is logged.
        attempts = []
        cut_off_retry_used = False
        for attempt in range(RETRIES + 1):
            a0 = time.time()
            data, err, status = self.call_openrouter(payload)
            latency = round((time.time() - a0) * 1000)
            if err:
                attempts.append({"error": err})
                log_call({"ts": a0, "kind": "chat", "tag": tag, "model": MODEL, "attempt": attempt + 1, "error": err, "latency_ms": latency})
                if status in (408, 429, 500, 502, 503, 504) or status is None:
                    time.sleep(min(20, 2 ** (attempt + 1)) + random.random())
                    continue
                break
            choice = (data.get("choices") or [{}])[0]
            message = choice.get("message") or {}
            content = message.get("content") or ""
            # Ripple is a reasoning model; OpenRouter returns its thinking separately.
            reasoning = message.get("reasoning") or ""
            finish = choice.get("finish_reason")
            provider = data.get("provider")
            attempts.append({"provider": provider, "finish_reason": finish, "latency_ms": latency})
            log_call(
                {
                    "ts": a0,
                    "kind": "chat",
                    "tag": tag,
                    "attempt": attempt + 1,
                    "model": data.get("model", MODEL),
                    "provider": provider,
                    "temperature": payload["temperature"],
                    "max_tokens": payload["max_tokens"],
                    "provider_request": payload.get("provider"),
                    "reasoning_request": payload.get("reasoning"),
                    "tools": [t.get("function", {}).get("name") for t in payload.get("tools", [])],
                    "tool_calls": message.get("tool_calls"),
                    "messages": payload["messages"],
                    "reasoning": reasoning,
                    "reply": content,
                    "finish_reason": finish,
                    "usage": data.get("usage"),
                    "latency_ms": latency,
                }
            )
            tool_calls = message.get("tool_calls")
            if content or tool_calls:
                return self.send_json(
                    200,
                    {
                        "content": content,
                        "tool_calls": tool_calls,
                        "reasoning": reasoning,
                        "finish_reason": finish,
                        "model": data.get("model", MODEL),
                        "provider": provider,
                        "latency_ms": round((time.time() - t0) * 1000),
                        "usage": data.get("usage"),
                        "attempts": attempts,
                    },
                )
            if finish == "length" and not cut_off_retry_used:
                cut_off_retry_used = True
                payload = {
                    **payload,
                    "messages": messages
                    + [{"role": "user", "content": "Your previous reply ran out of space before the answer. Reply now with only the JSON object, without further deliberation."}],
                }
                continue
            break
        last = attempts[-1] if attempts else {}
        why = last.get("error") or (
            f"cut off by the {payload['max_tokens']}-token output limit" if last.get("finish_reason") == "length" else f"finish_reason={last.get('finish_reason')}"
        )
        return self.send_json(502, {"error": f"no usable reply after {len(attempts)} attempt(s): {why}", "attempts": attempts})

    def call_openrouter(self, payload):
        """Returns (data, error, http_status)."""
        http_req = urllib.request.Request(
            OPENROUTER_URL,
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": f"Bearer {API_KEY}",
                "Content-Type": "application/json",
                "X-Title": "Ripple Lab simulation",
            },
        )
        try:
            with urllib.request.urlopen(http_req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read()), None, 200
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            return None, f"HTTP {exc.code}: {detail}", exc.code
        except Exception as exc:  # noqa: BLE001
            return None, f"request failed: {exc}", None


def main():
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8000))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    mode = f"model {MODEL}" if API_KEY else "no OPENROUTER_API_KEY: offline heuristic only"
    print(f"Ripple sim on http://localhost:{port}  ({mode})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
