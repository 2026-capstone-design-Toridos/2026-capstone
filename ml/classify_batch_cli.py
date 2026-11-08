"""Classify a JSON batch from stdin using the same model as cluster_server."""
from __future__ import annotations

import argparse
import json
import sys

from cluster_server import ClusterPredictor, events_to_tokens


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model_dir", default="output/unsupervised_semantic")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    payload = json.load(sys.stdin)
    predictor = ClusterPredictor(args.model_dir, device=args.device)
    results = []
    for session in payload.get("sessions") or []:
        tokens = session.get("tokens")
        if tokens is None:
            tokens = events_to_tokens(session.get("events") or [])
        result = predictor.classify(tokens)
        if session.get("session_id"):
            result["session_id"] = session["session_id"]
        results.append(result)
    json.dump({"results": results, "count": len(results)}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
