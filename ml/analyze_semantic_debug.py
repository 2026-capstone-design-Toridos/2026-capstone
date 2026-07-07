"""
analyze_semantic_debug.py — GhostTracker 시맨틱 디버그 분석 스크립트

역할: build_session_sequences.py --debug 모드로 생성한 session_semantic_debug_*.json을 읽어
     세션 길이 분포, 토큰 빈도, 이벤트 유형별 분포를 요약하고 시각화한다.

주요 흐름:
  load_debug      — JSON 파일 로드
  analyze_sessions — 세션별 토큰·페이지·섹션 집계
  print_report    — 콘솔 요약 출력
  save_bar_chart  — 상위 토큰/이벤트 막대 차트 저장
"""

import argparse
import json
import os
from collections import Counter, defaultdict

import matplotlib.pyplot as plt


# debug JSON 파일을 읽어 세션 목록으로 반환한다
def load_debug(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# 출력 디렉토리가 없으면 생성한다
def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def token_parts(token):
    """
    PAGE|SEMANTIC|CONTEXTUAL 형태를 분리한다.
    """
    if not token or "|" not in token:
        return "UNKNOWN", "UNKNOWN", "UNKNOWN"

    parts = token.split("|")
    page = parts[0] if len(parts) > 0 else "UNKNOWN"
    semantic = parts[1] if len(parts) > 1 else "UNKNOWN"
    contextual = parts[2] if len(parts) > 2 else "UNKNOWN"
    return page, semantic, contextual


# 세션 목록을 순회해 토큰·이벤트·페이지·섹션별 빈도를 집계하고 요약 dict를 반환한다
def analyze_sessions(sessions):
    session_lengths = []
    token_counter = Counter()
    event_counter = Counter()
    unknown_counter = Counter()
    page_counter = Counter()
    section_counter = Counter()
    semantic_counter = Counter()
    contextual_counter = Counter()

    page_token_counter = defaultdict(Counter)
    section_token_counter = defaultdict(Counter)

    long_sessions = []
    short_sessions = []

    for session in sessions:
        session_id = session.get("session_id")
        events = session.get("debug_events", [])
        length = len(events)
        session_lengths.append((session_id, length))

        if length <= 2:
            short_sessions.append((session_id, length))
        if length >= 100:
            long_sessions.append((session_id, length))

        for e in events:
            event_type = e.get("event_type") or "UNKNOWN_EVENT_TYPE"
            token = e.get("semantic_token") or "NO_TOKEN"
            page = e.get("page") or "UNKNOWN_PAGE"
            section = e.get("section") or "NO_SECTION"

            token_counter[token] += 1
            event_counter[event_type] += 1
            page_counter[page] += 1
            section_counter[section] += 1

            token_page, semantic, contextual = token_parts(token)
            semantic_counter[semantic] += 1
            contextual_counter[contextual] += 1

            page_token_counter[token_page][token] += 1
            section_token_counter[section][token] += 1

            if "UNKNOWN_EVENT" in token:
                unknown_counter[event_type] += 1

    return {
        "session_lengths": session_lengths,
        "token_counter": token_counter,
        "event_counter": event_counter,
        "unknown_counter": unknown_counter,
        "page_counter": page_counter,
        "section_counter": section_counter,
        "semantic_counter": semantic_counter,
        "contextual_counter": contextual_counter,
        "page_token_counter": page_token_counter,
        "section_token_counter": section_token_counter,
        "long_sessions": long_sessions,
        "short_sessions": short_sessions,
    }


# Counter를 top_n 개씩 콘솔에 출력한다
def print_counter(title, counter, top_n=20):
    print(f"\n=== {title} ===")
    if not counter:
        print("(none)")
        return

    for key, count in counter.most_common(top_n):
        print(f"{key}: {count}")


# 세션 수·이벤트 수·길이 분포·상위 토큰 등 전체 분석 결과를 콘솔에 출력한다
def print_report(sessions, result, top_n=20):
    total_sessions = len(sessions)
    total_events = sum(length for _, length in result["session_lengths"])
    non_empty_sessions = sum(1 for _, length in result["session_lengths"] if length > 0)

    lengths = [length for _, length in result["session_lengths"]]

    print("\n==============================")
    print("Semantic Debug Analysis Report")
    print("==============================")

    print(f"\nTotal sessions       : {total_sessions}")
    print(f"Non-empty sessions   : {non_empty_sessions}")
    print(f"Total debug events   : {total_events}")

    if lengths:
        print(f"Min session length   : {min(lengths)}")
        print(f"Max session length   : {max(lengths)}")
        print(f"Avg session length   : {sum(lengths) / len(lengths):.2f}")

    print_counter("Top Tokens", result["token_counter"], top_n)
    print_counter("Top Event Types", result["event_counter"], top_n)
    print_counter("Top Semantic Actions", result["semantic_counter"], top_n)
    print_counter("Top Contextual Buckets", result["contextual_counter"], top_n)
    print_counter("Page Distribution", result["page_counter"], top_n)
    print_counter("Section Distribution", result["section_counter"], top_n)
    print_counter("UNKNOWN_EVENT by event_type", result["unknown_counter"], top_n)

    print("\n=== Long Sessions length >= 100 ===")
    if result["long_sessions"]:
        for session_id, length in sorted(result["long_sessions"], key=lambda x: x[1], reverse=True)[:top_n]:
            print(f"{session_id}: {length}")
    else:
        print("(none)")

    print("\n=== Short Sessions length <= 2 ===")
    if result["short_sessions"]:
        for session_id, length in result["short_sessions"][:top_n]:
            print(f"{session_id}: {length}")
    else:
        print("(none)")

    print("\n=== Page별 Top Token ===")
    for page, counter in result["page_token_counter"].items():
        print(f"\n[{page}]")
        for token, count in counter.most_common(10):
            print(f"  {token}: {count}")

    print("\n=== Section별 Top Token ===")
    for section, counter in result["section_token_counter"].items():
        print(f"\n[{section}]")
        for token, count in counter.most_common(10):
            print(f"  {token}: {count}")


# Counter의 상위 top_n 항목을 가로 막대 차트로 저장한다
def save_bar_chart(counter, title, output_path, top_n=15):
    if not counter:
        return

    items = counter.most_common(top_n)
    labels = [str(k) for k, _ in items]
    values = [v for _, v in items]

    plt.figure(figsize=(12, 7))
    plt.barh(labels[::-1], values[::-1])
    plt.title(title)
    plt.xlabel("Count")
    plt.tight_layout()
    plt.savefig(output_path, dpi=160)
    plt.close()


# 세션 길이 분포를 히스토그램으로 저장한다
def save_length_histogram(session_lengths, output_path):
    lengths = [length for _, length in session_lengths]

    if not lengths:
        return

    plt.figure(figsize=(10, 6))
    plt.hist(lengths, bins=20)
    plt.title("Session Length Distribution")
    plt.xlabel("Session Length")
    plt.ylabel("Session Count")
    plt.tight_layout()
    plt.savefig(output_path, dpi=160)
    plt.close()


# 세션별 길이를 CSV로 저장한다
def save_csv_summary(result, output_dir):
    path = os.path.join(output_dir, "session_length_summary.csv")

    with open(path, "w", encoding="utf-8-sig") as f:
        f.write("session_id,length\n")
        for session_id, length in sorted(result["session_lengths"], key=lambda x: x[1], reverse=True):
            f.write(f"{session_id},{length}\n")

    return path


# CLI 진입점 — JSON 로드 → 분석 → 콘솔 출력 → 차트·CSV 저장
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--debug", required=True, help="session_semantic_debug_*.json path")
    parser.add_argument("--output-dir", default="ml/output/analysis", help="analysis output directory")
    parser.add_argument("--top-n", type=int, default=20)
    args = parser.parse_args()

    sessions = load_debug(args.debug)
    result = analyze_sessions(sessions)

    print_report(sessions, result, args.top_n)

    ensure_dir(args.output_dir)

    save_bar_chart(
        result["token_counter"],
        "Top Semantic Tokens",
        os.path.join(args.output_dir, "top_tokens.png"),
        top_n=15,
    )

    save_bar_chart(
        result["event_counter"],
        "Top Event Types",
        os.path.join(args.output_dir, "top_event_types.png"),
        top_n=15,
    )

    save_bar_chart(
        result["semantic_counter"],
        "Top Semantic Actions",
        os.path.join(args.output_dir, "top_semantic_actions.png"),
        top_n=15,
    )

    save_bar_chart(
        result["section_counter"],
        "Section Distribution",
        os.path.join(args.output_dir, "section_distribution.png"),
        top_n=15,
    )

    save_length_histogram(
        result["session_lengths"],
        os.path.join(args.output_dir, "session_length_distribution.png"),
    )

    csv_path = save_csv_summary(result, args.output_dir)

    print("\nSaved analysis files:")
    print(f"- {os.path.join(args.output_dir, 'top_tokens.png')}")
    print(f"- {os.path.join(args.output_dir, 'top_event_types.png')}")
    print(f"- {os.path.join(args.output_dir, 'top_semantic_actions.png')}")
    print(f"- {os.path.join(args.output_dir, 'section_distribution.png')}")
    print(f"- {os.path.join(args.output_dir, 'session_length_distribution.png')}")
    print(f"- {csv_path}")


if __name__ == "__main__":
    main()