"""Offline service tests. No Laya/torch import, model downloads, or GPU required."""

import http.client
import json
import threading
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace

from server import LayaBackend, RequestError, check_token_budget, create_server, validate_body


class FakeBackend:
    names = ("english",)

    def __init__(self):
        self.calls = []
        self.busy = False
        self.failure = None

    def predict(self, body):
        self.calls.append(body)
        if self.failure:
            raise self.failure
        if self.busy:
            return None
        return {"model": "fake-checkpoint", "usage": {"input_tokens": 10, "output_tokens": 0}, "answers": {"refund": {"type": "noul", "noul": 0.9}}}


def request_body():
    return {"state": "Refund please", "questions": {"refund": {"type": "noul", "instructions": "Refund requested?"}}}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.server = create_server(("127.0.0.1", 0), self.backend, "test-key")
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def call(self, body=None, key="test-key", path="/v1/systemone", method="POST"):
        data = json.dumps(body if body is not None else request_body()).encode() if method == "POST" else None
        req = urllib.request.Request(f"http://127.0.0.1:{self.server.server_address[1]}{path}", data=data, method=method, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            response = urllib.request.urlopen(req, timeout=2)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.loads(response.read())

    def test_predict(self):
        status, result = self.call()
        self.assertEqual(status, 200)
        self.assertEqual(result["answers"]["refund"]["noul"], 0.9)
        self.assertEqual(len(self.backend.calls), 1)

    def test_auth_before_inference(self):
        self.assertEqual(self.call(key="wrong")[0], 401)
        self.assertEqual(self.backend.calls, [])

    def test_health_and_not_found(self):
        self.assertEqual(self.call(path="/healthz", method="GET"), (200, {"ready": True, "models": ["english"]}))
        self.assertEqual(self.call(path="/bad")[0], 404)

    def test_invalid_request_and_oversize(self):
        self.assertEqual(self.call(body={"state": None, "questions": {}})[0], 422)
        # Send only the oversized Content-Length. Rejection must precede reading
        # the body; sending megabytes races the server closing the connection.
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            connection.putrequest("POST", "/v1/systemone")
            connection.putheader("Authorization", "Bearer test-key")
            connection.putheader("Content-Length", str(2 * 1024 * 1024 + 1))
            connection.endheaders()
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            response.read()
        finally:
            connection.close()
        self.assertEqual(self.backend.calls, [])

    def test_busy_and_safe_failure(self):
        self.backend.busy = True
        self.assertEqual(self.call()[0], 503)
        self.backend.failure = RuntimeError("private-user-input")
        self.assertEqual(self.call(), (500, {"error": "Laya inference failed"}))

    def test_truncation_failure(self):
        self.backend.failure = RequestError("Too long")
        self.assertEqual(self.call()[0], 422)

    def test_no_unauthenticated_configuration(self):
        with self.assertRaises(RequestError):
            create_server(("127.0.0.1", 0), self.backend, "")


class BudgetTests(unittest.TestCase):
    def agent(self):
        class Tokenizer:
            mask_token = "[MASK]"

            def __call__(self, text, **_kwargs):
                return {"input_ids": text.split()}

        return SimpleNamespace(tok=Tokenizer(), cfg={"max_len": 32, "head_max_len": 24}, _to_internal=lambda q: {"t": q["type"], "ins": q["instructions"]})

    def check(self, state, instructions="Refund?", options=None):
        check_token_budget(self.agent(), state, {"q": {"type": "noul", "instructions": instructions}}, lambda _q: options or ["false", "true"], lambda value: value)

    def test_short_request_and_truncation_boundaries(self):
        self.check("Refund please")
        for state, instructions, options in [
            ("word " * 40, "Refund?", None),
            ("short", "instruction " * 40, None),
            ("short", "Refund?", ["option " * 49, "other"]),
        ]:
            with self.assertRaises(RequestError):
                self.check(state, instructions, options)

    def test_busy_inference_returns_without_loading_a_checkpoint(self):
        backend = LayaBackend.__new__(LayaBackend)
        backend.lock = threading.Lock()
        backend.lock.acquire()
        self.assertIsNone(backend.predict(request_body()))
        backend.lock.release()

    def test_wire_question_validation(self):
        for question in [
            {"type": "choice", "instructions": "?", "criteria": {"only": None}},
            {"type": "score", "instructions": "?", "criteria": ["one"]},
            {"type": "noul", "instructions": "?", "criteria": {"invalid": "yes"}},
            {"type": "unknown", "instructions": "?"},
        ]:
            with self.assertRaises(RequestError):
                validate_body({"state": "text", "questions": {"q": question}})


if __name__ == "__main__":
    unittest.main()
