"""Small, authenticated Laya HTTP service; inference stays outside Node.js.

Run one process per device. The lock serializes inference and checkpoint access.
Only configured, preloaded checkpoints are served; no request downloads models.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_BODY_BYTES = 2 * 1024 * 1024


class RequestError(Exception):
    """A safe client error; never put submitted state or credentials in its text."""


def check_token_budget(agent, state, questions, render_options, serialize_state):
    """Reject truncation using the formatting/token budgets of pinned Laya 0.3.5.

    This deliberately rejects long option descriptions even if their distinguishing
    words happen to fit. Updating Laya requires revalidating this boundary.
    """
    tok = agent.tok
    mask = tok.mask_token
    max_len = agent.cfg.get("max_len", 512)
    head_max_len = agent.cfg.get("head_max_len", 192)
    state_tokens = tok(serialize_state(state).replace(mask, " "), add_special_tokens=False)["input_ids"]
    for question in questions.values():
        internal = agent._to_internal(question)
        instructions = str(internal["ins"]).replace(mask, " ")
        head = tok(f"{internal['t']} question: {instructions}", add_special_tokens=False)["input_ids"]
        options = [
            tok(" " + option.replace(mask, " "), add_special_tokens=False)["input_ids"]
            for option in render_options(internal)
        ]
        option_size = sum(len(option) + 1 for option in options)
        remaining = head_max_len - option_size
        if any(len(option) > 48 for option in options) or remaining < 16 or len(head) > max(8, remaining):
            raise RequestError("Question exceeds the checkpoint instruction/option token budget")
        if len(head) + option_size + len(state_tokens) + 4 > max_len:
            raise RequestError("State exceeds the checkpoint token budget; shorten the supplied state")


class LayaBackend:
    def __init__(self):
        # Importing this module and running service contract tests never downloads weights.
        from laya import Router
        from laya.common import render_options, serialize_state

        names = [name.strip() for name in os.environ.get("LAYA_MODELS", "english").split(",")]
        if not names or any(name not in {"english", "multilingual", "typed-decisions"} for name in names):
            raise RequestError("LAYA_MODELS must list english, multilingual, and/or typed-decisions")
        self.names = tuple(dict.fromkeys(names))
        self.router = Router(device=os.environ.get("LAYA_DEVICE", "cpu"), max_loaded=len(self.names))
        self.router.preload(list(self.names))
        self.render_options = render_options
        self.serialize_state = serialize_state
        self.lock = threading.Lock()

    def predict(self, body):
        # Reject rather than queue unbounded inference behind one busy device.
        if not self.lock.acquire(blocking=False):
            return None
        try:
            decision = self.router.route(body["state"], body["questions"], model=body.get("model"), lang=body.get("lang"))
            if decision.model not in self.names:
                raise RequestError("Selected checkpoint is not preloaded; configure LAYA_MODELS or select a loaded model")
            agent = self.router.load(decision.model)
            check_token_budget(agent, body["state"], body["questions"], self.render_options, self.serialize_state)
            result = agent.predict(body["state"], body["questions"])
            result["routing"] = dict(decision)
            return result
        finally:
            self.lock.release()


def validate_body(body):
    # The HTTP boundary also validates callers that do not use the TypeScript adapter.
    if not isinstance(body, dict) or set(body) - {"state", "questions", "model", "lang"}:
        raise RequestError("Invalid request object")
    if not isinstance(body.get("state"), (str, dict, list)):
        raise RequestError("state must be a string, object, or array")
    questions = body.get("questions")
    if not isinstance(questions, dict) or not 1 <= len(questions) <= 256:
        raise RequestError("Provide 1–256 questions")
    for field in ("model", "lang"):
        if field in body and (not isinstance(body[field], str) or not 1 <= len(body[field]) <= 256):
            raise RequestError("Invalid model or language")
    for key, question in questions.items():
        if not key or not isinstance(question, dict) or set(question) - {"type", "instructions", "criteria"}:
            raise RequestError("Invalid question")
        if not isinstance(question.get("instructions"), (str, dict, list)):
            raise RequestError("Invalid question instructions")
        kind, criteria = question.get("type"), question.get("criteria")
        if kind == "choice":
            if not isinstance(criteria, dict) or not 2 <= len(criteria) <= 255 or any(not k for k in criteria):
                raise RequestError("Choice requires 2–255 options")
            if any(v is not None and not isinstance(v, (str, dict, list)) for v in criteria.values()):
                raise RequestError("Invalid choice criteria")
        elif kind == "score":
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10 or any(not isinstance(v, (str, dict, list)) for v in criteria):
                raise RequestError("Score requires 2–10 descriptive levels")
        elif kind == "noul":
            if criteria is not None and (not isinstance(criteria, dict) or set(criteria) - {"true", "false"} or any(not isinstance(v, (str, dict, list)) for v in criteria.values())):
                raise RequestError("Invalid noul criteria")
        else:
            raise RequestError("Unsupported question type")
    return body


def create_server(address, backend, api_key):
    if not api_key or api_key.strip() != api_key or any(char in api_key for char in "\r\n"):
        raise RequestError("Set a nonempty LAYA_API_KEY without surrounding whitespace")

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def respond(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if status == 503:
                self.send_header("Retry-After", "1")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # A cancelled HTTP request cannot interrupt an active GPU kernel.

        def do_GET(self):
            self.respond(200, {"ready": True, "models": backend.names}) if self.path == "/healthz" else self.respond(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/v1/systemone":
                return self.respond(404, {"error": "Not found"})
            expected = f"Bearer {api_key}".encode()
            supplied = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(expected, supplied):
                return self.respond(401, {"error": "Unauthorized"})
            if self.headers.get("Transfer-Encoding"):
                return self.respond(400, {"error": "Chunked requests are not supported"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_BODY_BYTES:
                return self.respond(413, {"error": "Provide a JSON body of at most 2 MiB"})
            try:
                def reject_constant(_value):
                    raise RequestError("Non-finite numbers are not JSON")
                body = validate_body(json.loads(self.rfile.read(length), parse_constant=reject_constant))
                result = backend.predict(body)
                if result is None:
                    return self.respond(503, {"error": "Inference device busy"})
                self.respond(200, result)
            except (RequestError, ValueError, KeyError, RecursionError):
                self.respond(422, {"error": "Invalid request or checkpoint token budget exceeded"})
            except Exception:
                self.respond(500, {"error": "Laya inference failed"})

        def log_message(self, _format, *_args):
            pass  # Request bodies, API keys, and submitted text are never logged.

    return ThreadingHTTPServer(address, Handler)


if __name__ == "__main__":
    key = os.environ.get("LAYA_API_KEY", "")
    if not key:
        raise SystemExit("Set LAYA_API_KEY before starting the service")
    backend = LayaBackend()
    server = create_server((os.environ.get("LAYA_HOST", "127.0.0.1"), int(os.environ.get("LAYA_PORT", "8080"))), backend, key)
    print(f"Laya ready on {server.server_address[0]}:{server.server_address[1]}; checkpoints: {', '.join(backend.names)}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
