"""Adversarial HTTP and inference-boundary regressions; fake models only."""

import http.client
import json
import socket
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

import test_server as fixtures
from server import LayaBackend, RequestError, check_token_budget, create_server, validate_body


class HttpAudit(unittest.TestCase):
    def setUp(self):
        self.backend = fixtures.FakeBackend()
        self.server = create_server(("127.0.0.1", 0), self.backend, "test-key")
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def send(self, data=None, extra=(), content_type="application/json", length=None, incomplete=False):
        data = json.dumps(fixtures.request_body()).encode() if data is None else data
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        try:
            conn.putrequest("POST", "/v1/systemone")
            conn.putheader("Authorization", "Bearer test-key")
            conn.putheader("Content-Type", content_type)
            conn.putheader("Content-Length", str(len(data) if length is None else length))
            for k, v in extra:
                conn.putheader(k, v)
            conn.endheaders(data)
            if incomplete:
                conn.sock.shutdown(socket.SHUT_WR)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_L01_numeric_overflow_cannot_enter_inference(self):
        data = b'{"state":{"value":1e999},"questions":{"p":{"type":"noul","instructions":"?"}}}'
        self.assertEqual(self.send(data)[0], 422)
        self.assertEqual(self.backend.calls, [])

    def test_L02_duplicate_json_keys_are_rejected(self):
        data = b'{"state":"first","state":"second","questions":{"p":{"type":"noul","instructions":"?"}}}'
        self.assertEqual(self.send(data)[0], 422)
        self.assertEqual(self.backend.calls, [])

    def test_L03_duplicate_content_lengths_are_rejected(self):
        data = json.dumps(fixtures.request_body()).encode()
        self.assertEqual(self.send(data, extra=[("Content-Length", str(len(data)))])[0], 400)

    def test_L04_duplicate_auth_headers_are_rejected(self):
        self.assertEqual(self.send(extra=[("Authorization", "Bearer other")])[0], 401)

    def test_L05_incomplete_body_is_not_run_as_a_valid_shorter_request(self):
        self.assertEqual(self.send(length=999, incomplete=True)[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_L06_unsupported_content_encoding_is_explicit(self):
        self.assertEqual(self.send(extra=[("Content-Encoding", "gzip")])[0], 415)

    def test_L07_wrong_content_type_is_rejected(self):
        self.assertEqual(self.send(content_type="text/plain")[0], 415)

    def test_L08_utf16_is_not_accepted_as_utf8_json(self):
        data = json.dumps(fixtures.request_body()).encode("utf-16")
        self.assertEqual(self.send(data)[0], 422)

    def test_L09_inference_value_errors_are_server_errors(self):
        self.backend.failure = ValueError("private checkpoint failure")
        self.assertEqual(self.send(), (500, {"error": "Laya inference failed"}))

    def test_L10_invalid_model_output_is_server_error(self):
        self.backend.predict = lambda _body: {"answers": {"p": float("nan")}}
        self.assertEqual(self.send()[0], 500)

    def test_L11_output_size_is_bounded(self):
        self.backend.predict = lambda _body: {"data": "x" * (2 * 1024 * 1024)}
        self.assertEqual(self.send()[0], 500)

    def test_L12_unpaired_unicode_surrogates_are_rejected_before_inference(self):
        data = b'{"state":"\\ud800","questions":{"p":{"type":"noul","instructions":"?"}}}'
        self.assertEqual(self.send(data)[0], 422)
        self.assertEqual(self.backend.calls, [])

    def test_L13_non_ascii_service_keys_fail_configuration(self):
        with self.assertRaises(RequestError):
            server = create_server(("127.0.0.1", 0), self.backend, "secret-ש")
            server.server_close()

    def test_L14_non_ascii_text_roundtrips_with_byte_content_length(self):
        body = fixtures.request_body()
        body["state"] = {"text": "נא להחזיר כסף 😀"}
        self.assertEqual(self.send(json.dumps(body, ensure_ascii=False).encode())[0], 200)
        self.assertEqual(self.backend.calls[0]["state"], body["state"])


class BackendAudit(unittest.TestCase):
    def make_backend(self, model="english"):
        backend = LayaBackend.__new__(LayaBackend)
        backend.names = ("english",)
        backend.lock = threading.Lock()
        class Route(dict):
            @property
            def model(self):
                return self["model"]
        agent = fixtures.BudgetTests().agent()
        agent.predict = Mock(return_value={"answers": {}})
        backend.router = SimpleNamespace(route=Mock(return_value=Route(model=model, repo="fake", reason="test")), load=Mock(return_value=agent))
        backend.render_options = lambda _q: ["false", "true"]
        backend.serialize_state = lambda value: value
        return backend, agent

    def test_L15_unpreloaded_checkpoint_does_not_trigger_loading(self):
        backend, _ = self.make_backend("multilingual")
        with self.assertRaises(RequestError):
            backend.predict(fixtures.request_body())
        backend.router.load.assert_not_called()

    def test_L16_failed_inference_releases_device_lock(self):
        backend, agent = self.make_backend()
        agent.predict.side_effect = [RuntimeError("failure"), {"answers": {}}]
        with self.assertRaises(RuntimeError):
            backend.predict(fixtures.request_body())
        self.assertIsNotNone(backend.predict(fixtures.request_body()))

    def test_L17_concurrent_inference_does_not_load_twice(self):
        backend, agent = self.make_backend()
        entered, finish = threading.Event(), threading.Event()
        def slow(_state, _questions):
            entered.set()
            finish.wait(2)
            return {"answers": {}}
        agent.predict.side_effect = slow
        thread = threading.Thread(target=lambda: backend.predict(fixtures.request_body()))
        thread.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertIsNone(backend.predict(fixtures.request_body()))
            backend.router.load.assert_called_once()
        finally:
            finish.set()
            thread.join()

    def test_L18_exact_state_token_budget_then_one_token_over(self):
        agent = fixtures.BudgetTests().agent()
        question = {"q": {"type": "noul", "instructions": "?"}}
        # head 3 + two option markers/labels 4 + special tokens 4 = 11.
        check_token_budget(agent, "word " * 21, question, lambda _q: ["false", "true"], lambda s: s)
        with self.assertRaises(RequestError):
            check_token_budget(agent, "word " * 22, question, lambda _q: ["false", "true"], lambda s: s)

    def test_L19_blank_model_and_language_fail_request_validation(self):
        for field in ("model", "lang"):
            with self.subTest(field=field), self.assertRaises(RequestError):
                validate_body({**fixtures.request_body(), field: "   "})

    def test_L20_invalid_route_is_a_client_error_without_loading(self):
        backend, _ = self.make_backend()
        backend.router.route.side_effect = ValueError("Unknown checkpoint")
        with self.assertRaises(RequestError):
            backend.predict(fixtures.request_body())
        backend.router.load.assert_not_called()
