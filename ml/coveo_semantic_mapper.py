"""
coveo_semantic_mapper.py
------------------------
Coveo SIGIR 2021 browsing_train.csv → PAGE|SEMANTIC|CONTEXTUAL 세션 시퀀스 변환

이벤트 매핑:
  event_product + detail   → PRODUCT|VIEW_PRODUCT|NONE
  event_product + add      → PRODUCT|ADD_CART|NONE
  event_product + remove   → CART|REMOVE_CART|NONE
  event_product + purchase → CHECKOUT|PURCHASE|NONE
  pageview (첫 이벤트)     → HOME|ENTER_HOME|NONE
  pageview (이후)          → HOME|SCROLL_HOME|NONE

Usage:
  python coveo_semantic_mapper.py \\
      --input  ../SIGIR-ecom-data-challenge/train/browsing_train.csv \\
      --output output/coveo_session_sequences.csv \\
      --max_sessions 20000 \\
      --min_len 3 \\
      --max_len 50
"""

from __future__ import annotations

import argparse
import csv
import os
import time
from collections import defaultdict
from typing import Dict, List, Tuple

import pandas as pd

# ── 이벤트 매핑 ─────────────────────────────────────────────────────────────
# (event_type, product_action) → (PAGE, SEMANTIC, CONTEXTUAL)
EVENT_MAP: Dict[Tuple[str, str], Tuple[str, str, str]] = {
    ("event_product", "detail"):   ("PRODUCT",  "VIEW_PRODUCT", "NONE"),
    ("event_product", "add"):      ("PRODUCT",  "ADD_CART",     "NONE"),
    ("event_product", "remove"):   ("CART",     "REMOVE_CART",  "NONE"),
    ("event_product", "purchase"): ("CHECKOUT", "PURCHASE",     "NONE"),
}

PAGEVIEW_FIRST_TOKEN = ("HOME", "ENTER_HOME",  "NONE")
PAGEVIEW_LATER_TOKEN = ("HOME", "SCROLL_HOME", "NONE")


def map_event(event_type: str, product_action: str, is_first: bool) -> Tuple[str, str, str] | None:
    """Coveo 이벤트 하나를 (PAGE, SEMANTIC, CONTEXTUAL) 로 변환. None = 스킵."""
    key = (event_type, product_action if pd.notna(product_action) else "")
    if key in EVENT_MAP:
        return EVENT_MAP[key]
    if event_type == "pageview":
        return PAGEVIEW_FIRST_TOKEN if is_first else PAGEVIEW_LATER_TOKEN
    return None  # 알 수 없는 이벤트 스킵


def token_str(page: str, semantic: str, contextual: str) -> str:
    return f"{page}|{semantic}|{contextual}"


def build_sessions(
    input_path: str,
    max_sessions: int,
    min_len: int,
    max_len: int,
    chunk_size: int = 500_000,
) -> List[Dict]:
    """browsing_train.csv → 세션 리스트 (session_id, sequence). 청크 방식으로 메모리 절약."""

    print(f"[coveo_mapper] 청크 방식으로 읽는 중: {input_path}")
    t0 = time.time()

    # 세션별 이벤트 버퍼 {session_id: [(timestamp, event_type, product_action), ...]}
    session_buffer: Dict[str, List] = defaultdict(list)
    completed: List[Dict] = []
    total_rows = 0

    reader = pd.read_csv(
        input_path,
        usecols=["session_id_hash", "event_type", "product_action", "server_timestamp_epoch_ms"],
        dtype={"session_id_hash": str, "event_type": str, "product_action": str},
        chunksize=chunk_size,
    )

    for chunk in reader:
        total_rows += len(chunk)
        for _, row in chunk.iterrows():
            sid = row["session_id_hash"]
            session_buffer[sid].append((
                row["server_timestamp_epoch_ms"],
                row["event_type"],
                row["product_action"],
            ))

        # 세션 수가 충분히 쌓이면 조기 종료 (max_sessions의 3배 버퍼 확보 후)
        if max_sessions and len(session_buffer) >= max_sessions * 3:
            print(f"  {total_rows:,}행 처리 후 조기 종료 (버퍼 {len(session_buffer):,} 세션)")
            break

        if total_rows % 2_000_000 == 0:
            print(f"  처리 중: {total_rows:,}행 …")

    print(f"[coveo_mapper] 로드 완료: {total_rows:,}행, {len(session_buffer):,} 세션 ({time.time()-t0:.1f}s)")

    # 세션별 정렬 및 토큰 변환
    sessions: List[Dict] = []
    session_count = 0

    for sid, events in session_buffer.items():
        if max_sessions and session_count >= max_sessions:
            break

        # 타임스탬프 기준 정렬
        events.sort(key=lambda x: x[0])

        tokens: List[str] = []
        for i, (ts, etype, paction) in enumerate(events):
            mapped = map_event(etype, paction, is_first=(i == 0))
            if mapped is None:
                continue
            tokens.append(token_str(*mapped))

        # 길이 필터
        if len(tokens) < min_len:
            continue
        if len(tokens) > max_len:
            tokens = tokens[:max_len]

        # START_SESSION 토큰 앞에 추가 (우리 포맷 맞추기)
        tokens = [token_str("HOME", "START_SESSION", "NONE")] + tokens

        start_ts = events[0][0]
        end_ts   = events[-1][0]

        sessions.append({
            "session_id":      f"coveo_{sid[:16]}",
            "start_timestamp": start_ts,
            "end_timestamp":   end_ts,
            "length":          len(tokens),
            "sequence":        " ".join(tokens),
        })
        session_count += 1

    print(f"[coveo_mapper] 유효 세션: {len(sessions):,}개")
    return sessions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",        default="../SIGIR-ecom-data-challenge/train/browsing_train.csv")
    parser.add_argument("--output",       default="output/coveo_session_sequences.csv")
    parser.add_argument("--max_sessions", type=int, default=20000, help="최대 세션 수 (0=전체)")
    parser.add_argument("--min_len",      type=int, default=3,     help="최소 토큰 길이")
    parser.add_argument("--max_len",      type=int, default=50,    help="최대 토큰 길이")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else ".", exist_ok=True)

    sessions = build_sessions(
        input_path=args.input,
        max_sessions=args.max_sessions,
        min_len=args.min_len,
        max_len=args.max_len,
    )

    # CSV 저장 (session_sequences_v2_merged.csv 와 동일한 포맷)
    fieldnames = ["session_id", "start_timestamp", "end_timestamp", "length", "sequence"]
    with open(args.output, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(sessions)

    print(f"[coveo_mapper] 저장 완료 → {args.output}  ({len(sessions):,} 세션)")


if __name__ == "__main__":
    main()
