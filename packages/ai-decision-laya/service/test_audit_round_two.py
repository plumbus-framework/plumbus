"""Second service audit: lifecycle, HTTP metadata and batch boundaries."""
import http.client
import json
import socket
import struct
import sys
import threading
import unittest
from types import ModuleType
from unittest.mock import Mock, patch

import test_audit as previous
import test_server as fixtures
from server import LayaBackend, RequestError, check_token_budget, create_server


class ServiceRoundTwo(unittest.TestCase):
    def setUp(self):
        self.backend = fixtures.FakeBackend()
        self.server = create_server(("127.0.0.1", 0), self.backend, "test-key")
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def send(self, extra=(), length="auto", auth="Bearer test-key", address=None):
        data = json.dumps(fixtures.request_body()).encode()
        conn = http.client.HTTPConnection(*(address or self.server.server_address), timeout=2)
        try:
            conn.putrequest("POST", "/v1/systemone")
            conn.putheader("Authorization", auth)
            conn.putheader("Content-Type", "application/json")
            if length is not None:
                conn.putheader("Content-Length", str(len(data)) if length == "auto" else length)
            for key, value in extra:
                conn.putheader(key, value)
            conn.endheaders(data)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_L23_missing_length_cannot_start_inference(self):
        self.assertEqual(self.send(length=None)[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_L24_signed_length_cannot_start_inference(self):
        self.assertEqual(self.send(length="+100")[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_L25_conflicting_content_types_are_rejected(self):
        self.assertEqual(self.send(extra=[("Content-Type", "text/plain")])[0], 415)

    def test_L26_conflicting_content_encodings_are_rejected(self):
        self.assertEqual(self.send(extra=[("Content-Encoding", "identity"), ("Content-Encoding", "gzip")])[0], 415)

    def test_L27_authentication_scheme_is_case_insensitive(self):
        self.assertEqual(self.send(auth="bEaReR test-key")[0], 200)

    def test_L28_client_disconnect_during_inference_does_not_escape_handler(self):
        entered, finish = threading.Event(), threading.Event()
        original = self.backend.predict
        def wait(body):
            entered.set()
            finish.wait(2)
            return original(body)
        self.backend.predict = wait
        self.server.handle_error = Mock()
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        body = json.dumps(fixtures.request_body())
        try:
            connection.request("POST", "/v1/systemone", body=body, headers={"Authorization": "Bearer test-key", "Content-Type": "application/json"})
            self.assertTrue(entered.wait(1))
            connection.sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            connection.close()
        finally:
            connection.close()
            finish.set()
        self.server.shutdown()
        self.server.server_close()  # Join handlers before inspecting their error outcome.
        self.server.handle_error.assert_not_called()

    def test_L29_connections_are_bounded_and_capacity_is_reusable(self):
        backend = fixtures.FakeBackend()
        entered, finish = threading.Event(), threading.Event()
        original = backend.predict
        def wait(body):
            entered.set()
            finish.wait(2)
            return original(body)
        backend.predict = wait
        server = create_server(("127.0.0.1", 0), backend, "test-key", max_connections=1)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        results = []
        first = threading.Thread(target=lambda: results.append(self.send(address=server.server_address)[0]))
        thread.start()
        first.start()
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.send(address=server.server_address)[0], 503)
            finish.set()
            first.join(2)
            self.assertEqual(results, [200])
            self.assertEqual(self.send(address=server.server_address)[0], 200)
        finally:
            finish.set()
            first.join(2)
            server.shutdown()
            server.server_close()
            thread.join()

    def test_L30_invalid_unicode_output_is_a_safe_server_error(self):
        self.backend.predict = lambda _body: {"result": "\ud800"}
        self.assertEqual(self.send(), (500, {"error": "Laya inference failed"}))

    def fake_modules(self):
        laya, common = ModuleType("laya"), ModuleType("laya.common")
        laya.Router = Mock()
        common.render_options = Mock()
        common.serialize_state = Mock()
        return laya, {"laya": laya, "laya.common": common}

    def test_L31_invalid_preload_list_does_not_construct_router(self):
        module, modules = self.fake_modules()
        with patch.dict(sys.modules, modules), patch.dict("os.environ", {"LAYA_MODELS": "invalid"}):
            with self.assertRaises(RequestError):
                LayaBackend()
            module.Router.assert_not_called()

    def test_L32_duplicate_preload_names_do_not_increase_model_count(self):
        module, modules = self.fake_modules()
        with patch.dict(sys.modules, modules), patch.dict("os.environ", {"LAYA_MODELS": "english,english,multilingual", "LAYA_DEVICE": "cpu"}):
            LayaBackend()
            module.Router.assert_called_once_with(device="cpu", max_loaded=2)
            module.Router.return_value.preload.assert_called_once_with(["english", "multilingual"])

    def test_L33_exact_option_budget_keeps_all_48_description_tokens(self):
        agent = fixtures.BudgetTests().agent()
        agent.cfg = {"max_len": 256, "head_max_len": 192}
        check_token_budget(agent, "short", {"q": {"type": "choice", "instructions": "?"}}, lambda _q: ["word " * 48, "other"], lambda s: s)
        with self.assertRaises(RequestError):
            check_token_budget(agent, "short", {"q": {"type": "choice", "instructions": "?"}}, lambda _q: ["word " * 49, "other"], lambda s: s)

    def test_L34_structured_state_reaches_model_without_replacement_by_serialized_text(self):
        backend, agent = previous.BackendAudit().make_backend()
        backend.serialize_state = lambda value: json.dumps(value, ensure_ascii=False)
        body = {**fixtures.request_body(), "state": {"text": "שלום"}}
        backend.predict(body)
        agent.predict.assert_called_once_with(body["state"], body["questions"])

    def test_L35_one_oversized_question_rejects_the_whole_batch_before_inference(self):
        backend, agent = previous.BackendAudit().make_backend()
        body = fixtures.request_body()
        body["questions"]["too_long"] = {"type": "noul", "instructions": "word " * 100}
        with self.assertRaises(RequestError):
            backend.predict(body)
        agent.predict.assert_not_called()

    def test_L36_callers_cannot_override_the_server_device(self):
        from server import validate_body
        with self.assertRaises(RequestError):
            validate_body({**fixtures.request_body(), "device": "cuda:9"})
