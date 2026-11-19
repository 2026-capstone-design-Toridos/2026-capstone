"""운영 에이전트용 이탈 집중 구역 캡처 실행기.

기존 exit_capture.capture_exit_hotspots를 CLI에서 호출하고, Node 서버가
읽을 수 있는 작은 JSON만 stdout으로 반환한다. 진행 로그는 stderr로 보낸다.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys

from exit_capture import capture_exit_hotspots


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--limit", type=int, default=2)
    args = parser.parse_args()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(args.out_dir, exist_ok=True)
    with contextlib.redirect_stdout(sys.stderr):
        rows = capture_exit_hotspots(
            base_dir,
            args.out_dir,
            args.start,
            args.end,
            limit=max(1, min(args.limit, 3)),
            origin=args.origin,
        )

    result = []
    for row in rows:
        capture_path = str(row.get("capture_path") or "")
        result.append({
            "url": row.get("url") or "",
            "section": row.get("section") or "unknown",
            "count": int(row.get("count") or 0),
            "share_pct": int(row.get("share_pct") or 0),
            "event_types": row.get("event_types") or {},
            "scroll_y": int(row.get("captured_scroll_y") or row.get("scroll_y") or 0),
            "section_found": bool(row.get("section_found")),
            "filename": os.path.basename(capture_path) if capture_path else "",
        })
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
