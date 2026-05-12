# DB/CSV에서 raw event log 읽기
# → session_id 기준으로 묶기
# → timestamp 기준 정렬
# → 현재 page / section / subsection 상태 추적
# → 각 event를 semantic_event_mapper로 넘기기
# → session별 semantic sequence 저장


"""
build_session_sequences.py

Raw event log를 session_id 기준으로 묶고,
시간순으로 정렬한 뒤,
semantic_event_mapper.py를 이용해 PAGE|SEMANTIC|CONTEXTUAL 시퀀스를 생성한다.

입력 지원:
  1. JSON / JSONL
  2. CSV
  3. MongoDB 직접 연결 옵션

출력:
  output/session_semantic_sequences.csv
  output/session_semantic_sequences.jsonl
"""

from __future__ import annotations

import argparse
import ast
import csv
import json
import os
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

try:
    from pymongo import MongoClient
except ImportError:
    MongoClient = None

from semantic_event_mapper import infer_page, map_event_to_semantic_token


Event = Dict[str, Any]

IGNORED_EVENTS = {
    "mouse_move",
    "scroll_speed",
    "scroll_stop",
    "scroll_direction_change",
    "time_to_first_click",
}

CONTEXT_ONLY_EVENTS = {
    "section_enter",
    "section_exit",
    "section_transition",
    "section_revisit",
    "subsection_enter",
    "subsection_exit",
    "subsection_revisit",
}


# =========================================================
# Loading
# =========================================================

def parse_data_field(value: Any) -> Any:
    """
    CSV에서 data가 문자열로 들어올 수 있으므로 dict로 복원.
    """
    if isinstance(value, dict):
        return value

    if value is None or value == "":
        return {}

    if isinstance(value, str):
        value = value.strip()

        try:
            return json.loads(value)
        except json.JSONDecodeError:
            pass

        try:
            return ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return {}

    return {}


def load_events_from_json(path: str) -> List[Event]:
    """
    .json 또는 .jsonl 지원.
    .json은 list[dict] 또는 {"events": [...]} 형태 지원.
    """
    events: List[Event] = []

    if path.endswith(".jsonl"):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                events.append(json.loads(line))
        return events

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    if isinstance(raw, list):
        events = raw
    elif isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events = raw["events"]
    else:
        raise ValueError("JSON 입력은 list[dict] 또는 {'events': [...]} 형태여야 합니다.")

    return events


def load_events_from_csv(path: str) -> List[Event]:
    events: List[Event] = []

    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)

        for row in reader:
            event = dict(row)

            event["data"] = parse_data_field(event.get("data"))

            for key in ["timestamp", "event_seq", "event_token", "inter_event_gap"]:
                if key in event and event[key] not in [None, ""]:
                    try:
                        event[key] = float(event[key])
                    except ValueError:
                        pass

            events.append(event)

    return events


def load_events_from_mongo(
    mongo_uri: str,
    db_name: str,
    collection_name: str = "events",
    limit: Optional[int] = None,
) -> List[Event]:
    if MongoClient is None:
        raise ImportError("pymongo가 설치되어 있지 않습니다. pip install pymongo 후 실행하세요.")

    client = MongoClient(mongo_uri)
    collection = client[db_name][collection_name]

    cursor = collection.find({}, {"_id": 0}).sort([("session_id", 1), ("timestamp", 1)])

    if limit:
        cursor = cursor.limit(limit)

    return list(cursor)


def load_events(args: argparse.Namespace) -> List[Event]:
    if args.mongo_uri:
        return load_events_from_mongo(
            mongo_uri=args.mongo_uri,
            db_name=args.mongo_db,
            collection_name=args.mongo_collection,
            limit=args.limit,
        )

    if not args.input:
        raise ValueError("--input 또는 --mongo-uri 중 하나는 필요합니다.")

    if args.input.endswith(".csv"):
        return load_events_from_csv(args.input)

    if args.input.endswith(".json") or args.input.endswith(".jsonl"):
        return load_events_from_json(args.input)

    raise ValueError("지원하지 않는 입력 형식입니다. csv, json, jsonl만 지원합니다.")


# =========================================================
# Session Context Tracking
# =========================================================

def event_sort_key(event: Event) -> tuple:
    """
    timestamp 우선, event_seq 보조 정렬.
    """
    timestamp = event.get("timestamp")
    event_seq = event.get("event_seq")

    try:
        timestamp = float(timestamp)
    except (TypeError, ValueError):
        timestamp = 0

    try:
        event_seq = float(event_seq)
    except (TypeError, ValueError):
        event_seq = 0

    return timestamp, event_seq


def group_by_session(events: Iterable[Event]) -> Dict[str, List[Event]]:
    sessions: Dict[str, List[Event]] = defaultdict(list)

    for event in events:
        session_id = event.get("session_id")

        if not session_id:
            continue

        sessions[str(session_id)].append(event)

    for session_id in sessions:
        sessions[session_id].sort(key=event_sort_key)

    return sessions


def get_data(event: Event) -> Dict[str, Any]:
    data = event.get("data", {})
    return data if isinstance(data, dict) else {}


def update_context(
    event: Event,
    *,
    current_section: Optional[str],
    current_subsection: Optional[str],
) -> tuple[Optional[str], Optional[str]]:
    """
    section_enter / subsection_enter / exit 이벤트를 읽고
    현재 사용자가 위치한 section/subsection 상태를 갱신한다.
    """
    event_type = event.get("event_type")
    data = get_data(event)

    if event_type == "section_enter":
        section = data.get("section")
        if section:
            current_section = str(section)

    elif event_type == "section_exit":
        section = data.get("section")
        if section and current_section == str(section):
            current_section = None

    elif event_type == "subsection_enter":
        subsection = data.get("subsection_id") or data.get("subsection")
        if subsection:
            current_subsection = str(subsection)

    elif event_type == "subsection_exit":
        subsection = data.get("subsection_id") or data.get("subsection")
        if subsection and current_subsection == str(subsection):
            current_subsection = None

    return current_section, current_subsection


def build_semantic_sequence_for_session(
    session_events: List[Event],
    *,
    include_unknown: bool = False,
    deduplicate_consecutive: bool = True,
) -> Dict[str, Any]:
    """
    세션 하나를 semantic token sequence로 변환.
    """
    if not session_events:
        return {
            "session_id": None,
            "sequence": [],
            "length": 0,
        }

    session_id = session_events[0].get("session_id")

    current_section: Optional[str] = None
    current_subsection: Optional[str] = None
    current_page: Optional[str] = None

    sequence: List[str] = []
    debug_events: List[Dict[str, Any]] = []

    for event in session_events:
        event_type = event.get("event_type")

        # sequence 학습에는 너무 raw한 이벤트는 제외
        if event_type in IGNORED_EVENTS:
            continue
        
        # 페이지는 이벤트마다 pathname 기반으로 업데이트
        inferred_page = infer_page(event)
        if inferred_page != "UNKNOWN":
            current_page = inferred_page

        # section/subsection 상태 갱신
        current_section, current_subsection = update_context(
            event,
            current_section=current_section,
            current_subsection=current_subsection,
        )

        token = map_event_to_semantic_token(
            event,
            current_page=current_page,
            current_section=current_section,
            current_subsection=current_subsection,
        )
        
        # section_enter/exit 등은 상태 추적용. 학습 토큰이 아님
        if token is None and event_type in CONTEXT_ONLY_EVENTS:
            continue

        if token is None and include_unknown:
            page = current_page or "UNKNOWN"
            token = f"{page}|UNKNOWN_EVENT|{event.get('event_type', 'UNKNOWN')}"

        if token:
            if deduplicate_consecutive and sequence and sequence[-1] == token:
                pass
            else:
                sequence.append(token)

            debug_events.append({
                "timestamp": event.get("timestamp"),
                "event_seq": event.get("event_seq"),
                "event_type": event.get("event_type"),
                "page": current_page,
                "section": current_section,
                "subsection": current_subsection,
                "semantic_token": token,
            })

    start_ts = session_events[0].get("timestamp")
    end_ts = session_events[-1].get("timestamp")

    return {
        "session_id": session_id,
        "start_timestamp": start_ts,
        "end_timestamp": end_ts,
        "length": len(sequence),
        "sequence": sequence,
        "debug_events": debug_events,
    }


def build_all_session_sequences(
    events: List[Event],
    *,
    include_unknown: bool = False,
    deduplicate_consecutive: bool = True,
) -> List[Dict[str, Any]]:
    sessions = group_by_session(events)

    results: List[Dict[str, Any]] = []

    for session_id, session_events in sessions.items():
        result = build_semantic_sequence_for_session(
            session_events,
            include_unknown=include_unknown,
            deduplicate_consecutive=deduplicate_consecutive,
        )
        results.append(result)

    results.sort(key=lambda x: str(x.get("start_timestamp", "")))

    return results


# =========================================================
# Output
# =========================================================

def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def save_sequences_csv(results: List[Dict[str, Any]], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "session_id",
                "start_timestamp",
                "end_timestamp",
                "length",
                "sequence",
            ],
        )
        writer.writeheader()

        for row in results:
            writer.writerow({
                "session_id": row.get("session_id"),
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "length": row.get("length"),
                "sequence": " ".join(row.get("sequence", [])),
            })


def save_sequences_jsonl(results: List[Dict[str, Any]], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8") as f:
        for row in results:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def save_debug_json(results: List[Dict[str, Any]], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    debug_rows = []

    for session in results:
        debug_rows.append({
            "session_id": session.get("session_id"),
            "debug_events": session.get("debug_events", []),
        })

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(debug_rows, f, ensure_ascii=False, indent=2)


def print_summary(results: List[Dict[str, Any]]) -> None:
    total_sessions = len(results)
    total_tokens = sum(row.get("length", 0) for row in results)
    non_empty = sum(1 for row in results if row.get("length", 0) > 0)

    vocab = defaultdict(int)

    for row in results:
        for token in row.get("sequence", []):
            vocab[token] += 1

    print("\n=== Semantic Sequence Build Summary ===")
    print(f"Sessions: {total_sessions}")
    print(f"Non-empty sessions: {non_empty}")
    print(f"Total semantic tokens: {total_tokens}")
    print(f"Vocab size: {len(vocab)}")

    print("\nTop 20 tokens:")
    for token, count in sorted(vocab.items(), key=lambda x: x[1], reverse=True)[:20]:
        print(f"  {token}: {count}")


# =========================================================
# CLI
# =========================================================

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build PAGE|SEMANTIC|CONTEXTUAL session sequences from raw GhostTracker events."
    )

    parser.add_argument(
        "--input",
        type=str,
        default=None,
        help="Raw event input file path. Supports csv/json/jsonl.",
    )

    parser.add_argument(
        "--mongo-uri",
        type=str,
        default=None,
        help="MongoDB URI. If provided, input file is ignored.",
    )

    parser.add_argument(
        "--mongo-db",
        type=str,
        default="ghosttracker",
        help="MongoDB database name.",
    )

    parser.add_argument(
        "--mongo-collection",
        type=str,
        default="events",
        help="MongoDB collection name.",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of MongoDB events for testing.",
    )

    parser.add_argument(
        "--output-dir",
        type=str,
        default="ml/output",
        help="Output directory.",
    )

    parser.add_argument(
        "--include-unknown",
        action="store_true",
        help="Include UNKNOWN_EVENT tokens for unmapped events.",
    )

    parser.add_argument(
        "--no-dedupe",
        action="store_true",
        help="Do not deduplicate consecutive identical tokens.",
    )

    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    events = load_events(args)

    results = build_all_session_sequences(
        events,
        include_unknown=args.include_unknown,
        deduplicate_consecutive=not args.no_dedupe,
    )

    timestamp = datetime.now().strftime("%Y%m%d_%H%M")

    csv_path = os.path.join(args.output_dir, f"session_semantic_sequences_{timestamp}.csv")
    jsonl_path = os.path.join(args.output_dir, f"session_semantic_sequences_{timestamp}.jsonl")
    debug_path = os.path.join(args.output_dir, f"session_semantic_debug_{timestamp}.json")

    save_sequences_csv(results, csv_path)
    save_sequences_jsonl(results, jsonl_path)
    save_debug_json(results, debug_path)

    print_summary(results)

    print("\nSaved:")
    print(f"  CSV   : {csv_path}")
    print(f"  JSONL : {jsonl_path}")
    print(f"  DEBUG : {debug_path}")


if __name__ == "__main__":
    main()