"""E2E-only inference fixture. This module is never used by the production entrypoint."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import create_server


class Backend:
    names = ("english", "multilingual")

    def predict(self, body):
        answers = {}
        for key, question in body["questions"].items():
            if question["type"] == "noul":
                answers[key] = {"type": "noul", "noul": 0.75, "confidence": 0.75}
            elif question["type"] == "choice":
                labels = list(question["criteria"])
                answers[key] = {"type": "choice", "choice": labels[0], "confidence": 1, "probabilities": {label: int(i == 0) for i, label in enumerate(labels)}}
            else:
                answers[key] = {"type": "score", "score": 1, "confidence": 1, "legend": {str(i): v for i, v in enumerate(question["criteria"])}, "probabilities": {str(i): int(i == 1) for i, _ in enumerate(question["criteria"])}}
        return {"model": "fixture", "answers": answers, "usage": {"input_tokens": 12, "output_tokens": 0}, "routing": {"model": body.get("model", "multilingual"), "repo": "fixture", "reason": "Fixture routing"}}


server = create_server(("127.0.0.1", 0), Backend(), "e2e-key")
print(json.dumps({"port": server.server_address[1]}), flush=True)
server.serve_forever()
