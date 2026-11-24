#!/usr/bin/env python3
"""Configure a local Ripple credential and verify hosted inference (stdlib only)."""

import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.request
import warnings

ROOT = Path(__file__).resolve().parents[1]
PROVIDERS = {
    "openrouter": (
        "https://openrouter.ai/api/v1",
        "ricursiveai/ripple-65b-preview",
        "OPENROUTER_API_KEY",
    ),
    "together": (
        "https://api.together.ai/v1",
        "ricursive-ai/Ripple-65B-Preview",
        "TOGETHER_API_KEY",
    ),
}


def read_env(path):
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.removeprefix("export ").split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                values[key.strip()] = value
    return values


def configuration(path, provider=None):
    values = {**read_env(path), **os.environ}
    provider = provider or values.get("RIPPLE_PROVIDER", "openrouter")
    if provider not in PROVIDERS:
        raise ValueError("RIPPLE_PROVIDER must be openrouter or together.")
    base, model, key_name = PROVIDERS[provider]
    return provider, base, model, key_name, values.get(key_name, "").strip()


def save_key(path, provider, key):
    if not re.fullmatch(r"[A-Za-z0-9_.-]{20,}", key):
        raise ValueError("Key is empty or contains unexpected characters; nothing saved.")
    if provider == "openrouter" and not re.fullmatch(r"sk-or-v1-[0-9a-f]{64}", key):
        raise ValueError("Expected an OpenRouter API key; nothing saved.")
    if path.is_symlink():
        raise ValueError("Refusing to write credentials through a symlink.")
    key_name = PROVIDERS[provider][2]
    lines = path.read_text().splitlines() if path.exists() else []
    names = {"RIPPLE_PROVIDER", key_name}
    lines = [line for line in lines if line.strip().removeprefix("export ").split("=", 1)[0].strip() not in names]
    lines.extend([f"RIPPLE_PROVIDER={provider}", f"{key_name}={key}"])
    # mkstemp creates a private file; replace atomically so the key is never world-readable.
    fd, temporary = tempfile.mkstemp(prefix=".ripple-env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as target:
            target.write("\n".join(lines) + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def complete(base, model, key, prompt, max_tokens):
    if not key:
        raise ValueError("No API key configured. Run: python3 scripts/ripple_api.py setup")
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
    }).encode()
    request = urllib.request.Request(
        base + "/chat/completions", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        # Don't echo arbitrary provider bodies, which could contain credentials or prompts.
        hints = {
            401: "API key rejected.", 402: "Provider credits are required.",
            403: "Key or account does not have access.",
            404: "Model or endpoint unavailable.", 429: "Provider rate limit reached.",
        }
        raise ValueError(f"HTTP {error.code}: {hints.get(error.code, 'Provider request failed.')} No retry sent.") from None
    except (urllib.error.URLError, TimeoutError):
        raise ValueError("Connection failed or timed out. No retry sent.") from None
    if result.get("error"):
        raise ValueError("Provider returned an error; connection is not verified.")
    try:
        choice = result["choices"][0]
        content = choice["message"].get("content")
    except (KeyError, IndexError, TypeError):
        raise ValueError("Provider returned no completion; connection is not verified.") from None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Provider returned no final text. The output budget may have been used by reasoning.")
    if choice.get("finish_reason") == "length":
        raise ValueError("Response reached the output limit; a complete answer is not verified.")
    return result, content


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup", "status", "check", "chat"])
    parser.add_argument("prompt", nargs="?")
    parser.add_argument("--provider", choices=PROVIDERS)
    parser.add_argument("--max-tokens", type=int, default=2048)
    args = parser.parse_args(argv)
    if not 1 <= args.max_tokens <= 8192:
        parser.error("--max-tokens must be between 1 and 8192")
    if args.command == "chat" and not args.prompt:
        parser.error("chat requires a prompt")
    try:
        path = ROOT / ".env"
        provider, base, model, key_name, key = configuration(path, args.provider)
        if args.command == "setup":
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                key = getpass.getpass(f"Paste {key_name} (hidden): ").strip()
            save_key(path, provider, key)
            print("Saved to .env with owner-only permissions. Key value hidden.")
            print("Run python3 scripts/ripple_api.py check to verify live inference.")
        elif args.command == "status":
            print(f"Provider: {provider}\nModel: {model}\nEndpoint: {base}")
            print(f"Credential: {'present' if key else 'missing'} (value hidden)")
            print("Live inference: not checked by this command")
            return 0 if key else 1
        else:
            prompt = args.prompt if args.command == "chat" else "Reply with exactly: Ripple connected."
            result, content = complete(base, model, key, prompt, args.max_tokens)
            print(content)
            print(f"Model: {result.get('model', model)}", file=sys.stderr)
            print("Usage: " + json.dumps(result.get("usage", {})), file=sys.stderr)
    except (ValueError, OSError, EOFError, getpass.GetPassWarning) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
