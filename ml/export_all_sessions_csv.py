"""MongoDB의 사이트 전체 세션을 분석 가능한 CSV 한 파일로 내보낸다."""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict
from datetime import timezone, timedelta
from pathlib import Path

from pymongo import MongoClient

from build_session_sequences import build_semantic_sequence_for_session, event_sort_key


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "output" / "clustering" / "dignolucir_all_sessions.csv"
DEFAULT_CLUSTER_RESULTS = HERE / "output" / "clustering" / "cluster_results.csv"
DEFAULT_META = HERE / "output" / "unsupervised_semantic" / "cluster_meta.json"

DIGNOLUCIR_ORIGINS = [
    "https://dignolucir.co.kr",
    "https://dignolucir.co.kr/",
    "https://www.dignolucir.co.kr",
    "https://www.dignolucir.co.kr/",
    "https://hshh2020.cafe24.com",
    "https://hshh2020.cafe24.com/",
    "https://hshh2020.cafe24api.com",
    "https://hshh2020.cafe24api.com/",
]

KST = timezone(timedelta(hours=9))


def iso_time(value, target_timezone=timezone.utc):
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(target_timezone).isoformat(timespec="milliseconds")


def load_cluster_assignments(path: Path):
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        return {
            row["session_id"]: {
                "cluster": row.get("cluster", ""),
                "probability": row.get("probability", ""),
            }
            for row in csv.DictReader(file)
        }


def ordered_unique(values):
    return list(dict.fromkeys(str(value).strip() for value in values if value not in (None, "")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--cluster-results", default=str(DEFAULT_CLUSTER_RESULTS))
    parser.add_argument("--meta", default=str(DEFAULT_META))
    args = parser.parse_args()

    mongo_uri = os.environ.get("MONGODB_URI", "").strip()
    if not mongo_uri:
        raise SystemExit("MONGODB_URI 환경변수가 필요합니다.")

    with open(args.meta, "r", encoding="utf-8") as file:
        vocab = json.load(file)["vocab"]
    assignments = load_cluster_assignments(Path(args.cluster_results))

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=10_000)
    collection = client["ghosttracker"]["events"]
    sessions = defaultdict(list)
    cursor = collection.find(
        {"origin": {"$in": DIGNOLUCIR_ORIGINS}},
        {
            "_id": 0, "session_id": 1, "origin": 1, "received_at": 1,
            "timestamp": 1, "event_seq": 1, "event_type": 1,
            "inter_event_gap": 1, "pathname": 1, "page_url": 1,
            "page_type": 1, "device_type": 1, "data": 1,
        },
    )
    for event in cursor:
        session_id = event.get("session_id")
        if not session_id:
            continue
        if event.get("timestamp") is None and event.get("received_at") is not None:
            event["timestamp"] = event["received_at"].replace(
                tzinfo=timezone.utc
            ).timestamp() * 1000
        sessions[str(session_id)].append(event)
    client.close()

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "session_id", "first_received_at_utc", "last_received_at_utc",
        "first_received_at_kst", "last_received_at_kst", "duration_seconds",
        "event_count", "origins", "device_types", "product_names",
        "product_click_count", "review_count", "wishlist_count", "cart_count",
        "purchase_click_count", "guest_purchase_count", "event_type_counts",
        "semantic_token_count", "unknown_token_count", "unknown_token_ratio",
        "quality_eligible", "quality_exclusion_reasons", "clustering_input",
        "cluster", "cluster_probability", "semantic_sequence",
    ]

    rows = []
    for session_id, events in sessions.items():
        events.sort(key=event_sort_key)
        received = [event.get("received_at") for event in events if event.get("received_at")]
        first_at = min(received) if received else None
        last_at = max(received) if received else None
        event_counts = Counter(str(event.get("event_type") or "unknown") for event in events)
        semantic = build_semantic_sequence_for_session(events)["sequence"]
        unknown_count = sum(1 for token in semantic if token not in vocab)
        unknown_ratio = unknown_count / len(semantic) if semantic else 1.0
        exclusion_reasons = []
        if len(semantic) < 3:
            exclusion_reasons.append("too_few_semantic_tokens")
        if unknown_ratio > 0.20:
            exclusion_reasons.append("too_many_unknown_tokens")

        product_names = ordered_unique(
            (event.get("data") or {}).get("product_name") for event in events
        )
        assignment = assignments.get(session_id, {})
        rows.append({
            "session_id": session_id,
            "first_received_at_utc": iso_time(first_at),
            "last_received_at_utc": iso_time(last_at),
            "first_received_at_kst": iso_time(first_at, KST),
            "last_received_at_kst": iso_time(last_at, KST),
            "duration_seconds": round((last_at - first_at).total_seconds(), 3) if first_at and last_at else "",
            "event_count": len(events),
            "origins": json.dumps(ordered_unique(event.get("origin") for event in events), ensure_ascii=False),
            "device_types": json.dumps(ordered_unique(event.get("device_type") for event in events), ensure_ascii=False),
            "product_names": json.dumps(product_names, ensure_ascii=False),
            "product_click_count": event_counts["product_click"],
            "review_count": sum(event_counts[name] for name in (
                "review_click", "review_image_click", "review_page_change",
                "review_scroll", "review_area_scroll",
            )),
            "wishlist_count": event_counts["wishlist_intent"] + event_counts["add_to_wishlist_success"],
            "cart_count": event_counts["add_to_cart"] + event_counts["add_to_cart_success"],
            "purchase_click_count": event_counts["purchase_click"],
            "guest_purchase_count": event_counts["guest_purchase"],
            "event_type_counts": json.dumps(dict(event_counts.most_common()), ensure_ascii=False),
            "semantic_token_count": len(semantic),
            "unknown_token_count": unknown_count,
            "unknown_token_ratio": round(unknown_ratio, 4),
            "quality_eligible": not exclusion_reasons,
            "quality_exclusion_reasons": json.dumps(exclusion_reasons, ensure_ascii=False),
            "clustering_input": session_id in assignments,
            "cluster": assignment.get("cluster", ""),
            "cluster_probability": assignment.get("probability", ""),
            "semantic_sequence": " ".join(semantic),
        })

    rows.sort(key=lambda row: row["last_received_at_utc"], reverse=True)
    with output.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(json.dumps({
        "output": str(output),
        "sessions": len(rows),
        "events": sum(row["event_count"] for row in rows),
        "clustering_input_sessions": sum(bool(row["clustering_input"]) for row in rows),
        "first_received_at_kst": min((row["first_received_at_kst"] for row in rows if row["first_received_at_kst"]), default=""),
        "last_received_at_kst": max((row["last_received_at_kst"] for row in rows if row["last_received_at_kst"]), default=""),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
