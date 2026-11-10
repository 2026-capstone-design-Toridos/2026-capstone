"""Build a weekly report by reusing the supplied design HTML verbatim.

The source pages keep their original 794 x 1123 DOM and inline styles.  Only
the report identity fields are replaced; no project CSS is layered on top.
"""
from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import base64
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"C:\SW4_2\졸작\[디자인] 주간 리포트.html")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip()


def split_pages(source: str) -> list[str]:
    """Return the exact x-dc page nodes embedded in the supplied document."""
    return re.findall(r"<x-dc>.*?</x-dc>", source, flags=re.S | re.I)


def display_site(origin: str) -> str:
    host = (urlparse(origin).hostname or origin or "Dignolucir").split(".")[0]
    return host[:1].upper() + host[1:]


def load_inputs(metrics_path: str = "", commerce_path: str = "", result_path: str = "") -> dict:
    def load_json(path: str) -> dict:
        if not path or not Path(path).exists():
            return {}
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))

    profiles = []
    if result_path and Path(result_path).exists():
        with Path(result_path).open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                row["count"] = int(float(row.get("count") or 0))
                row["top_actions"] = json.loads(row.get("top_actions_json") or "[]")
                row["page_dist"] = json.loads(row.get("page_dist_json") or "{}")
                profiles.append(row)
    return {"metrics": load_json(metrics_path), "commerce": load_json(commerce_path), "profiles": profiles}


def _extract_gemini_json(payload: dict) -> dict:
    parts = (((payload.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
    text = "".join(str(part.get("text") or "") for part in parts if not part.get("thought")).strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    match = re.search(r"\{.*\}", text, flags=re.S)
    return json.loads(match.group(0) if match else text)


def generate_weekly_ai(inputs: dict, start: str, end: str, origin: str) -> dict:
    """Interpret weekly aggregates with Gemini, with deterministic copy as fallback."""
    if not GEMINI_KEY:
        print("[report] GEMINI_API_KEY 없음 - 규칙 기반 문구로 생성", flush=True)
        return {}
    profiles = profile_order(inputs.get("profiles") or [])
    profile_total = sum(int(profile.get("count") or 0) for profile in profiles) or 1
    overview = (inputs.get("metrics") or {}).get("overview") or {}
    session_count = int(overview.get("sessions") or 0)
    metric_baselines = {
        "상품 상세 진입률": rate(int(overview.get("product_sessions") or 0), session_count),
        "장바구니 도달률": rate(int(overview.get("cart_sessions") or 0), session_count),
        "주문 전환율": rate(int(overview.get("orders") or 0), session_count),
    }
    aggregate = {
        "period": {"start": start, "end": end}, "site": display_site(origin),
        "metric_baselines_percent": metric_baselines,
        "metrics": inputs.get("metrics") or {}, "commerce": inputs.get("commerce") or {},
        "exit_hotspots": [{k: v for k, v in item.items() if k not in {"capture_b64"}} for item in (inputs.get("exit_hotspots") or [])],
        "customer_types": [{
            "name": p.get("name"), "count": p.get("count"), "share_percent": pct(int(p.get("count") or 0), profile_total),
            "summary": p.get("summary"),
            "current_action": p.get("action"), "top_actions": p.get("top_actions") or [],
            "page_dist": p.get("page_dist") or {},
        } for p in profiles],
    }
    prompt = """당신은 이커머스 주간 행동 데이터 분석가입니다. 아래 집계 데이터만 근거로 쇼핑몰 운영자가 바로 이해하고 실행할 수 있는 한국어 리포트 문구를 작성하세요.

[절대 규칙]
1. 입력에 없는 숫자, 상품명, 채널, 원인, 감정, 고객 특성, 할인율, 기대 매출을 만들지 마세요.
2. 숫자는 입력값을 그대로 인용하고 직접 재계산하지 마세요. 인과관계는 단정하지 말고 '점검이 필요합니다', '가능성이 있습니다'처럼 표현하세요.
3. 고객 유형은 입력된 5개를 빠짐없이, 입력 순서와 이름 그대로 반환하세요. 유형 비율은 각 유형의 share_percent만 그대로 사용하고 다른 분모로 재계산하지 마세요. 유형별 운영 의미·인사이트·조치는 서로 달라야 합니다.
4. 행동명과 페이지명은 입력 의미를 보존한 자연스러운 한국어로 표현하되 다른 행동으로 바꾸지 마세요.
5. 표본이 작거나 주문이 없으면 확정적 성과 판단을 피하세요. 마크다운, 번호 목록, HTML은 쓰지 마세요.

[필드별 작성 규칙]
- weekly_summary: 이번 주 핵심 변화 2문장.
- weekly_tasks: 가장 중요한 할 일 2개. title은 18자 이내, reason은 근거 수치 1개 이상, action은 화면·메시지·동선을 구체적으로 제시.
- funnel_guide: 가장 큰 중단 구간과 전주 비교를 읽는 법 2~3문장.
- channel_note: 채널별 표본과 주문 성과를 과장 없이 읽는 법 2문장.
- type_summary_intro: 가장 큰 유형 이름과 비율을 포함한 1문장.
- type_priority_action: 가장 먼저 대응할 유형과 이유, 조치를 2문장.
- commerce_summary: 상품·리뷰·카트·주문 행동을 연결한 2~3문장. 수집 오류를 임의 추정하지 말 것.
- customer_types.operational_meaning: 상세 제목 아래에 들어갈 1문장.
- customer_types.insight: 해당 유형의 근거 수치를 포함한 3문장. 마지막 문장은 운영상 의미를 설명.
- customer_types.recommended_action: 쇼핑몰 운영자가 수정할 화면·정보·메시지·동선과 다음 주 확인 항목을 포함한 구체적인 실행 조치 1~2문장. '개선하세요', '강화하세요'로만 끝내지 말 것.
- overall_recommendation: 5개 유형 전체를 아우르는 우선순위 제안 4문장.
- next_metrics: 이번 주 문제와 연결된 추적 지표 3개. metric_baselines_percent에 있는 지표를 우선 사용. success_signal에는 반드시 입력된 현재 기준값을 포함해 '현재 0.0%에서 상승'처럼 구체적으로 작성하고 새 목표 수치는 만들지 말 것.

반드시 지정된 JSON 구조로만 반환하세요.

집계 데이터:
""" + json.dumps(aggregate, ensure_ascii=False, separators=(",", ":"), default=str)
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2, "maxOutputTokens": 8192, "responseMimeType": "application/json",
            "thinkingConfig": {"thinkingBudget": 0},
            "responseJsonSchema": {
                "type": "object",
                "properties": {
                    "weekly_summary": {"type": "string"},
                    "weekly_tasks": {"type": "array", "minItems": 2, "maxItems": 2, "items": {
                        "type": "object", "properties": {"title": {"type": "string"}, "reason": {"type": "string"}, "action": {"type": "string"}},
                        "required": ["title", "reason", "action"],
                    }},
                    "funnel_guide": {"type": "string"}, "channel_note": {"type": "string"},
                    "type_summary_intro": {"type": "string"}, "type_priority_action": {"type": "string"},
                    "commerce_summary": {"type": "string"},
                    "customer_types": {"type": "array", "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"}, "operational_meaning": {"type": "string"},
                            "insight": {"type": "string"}, "recommended_action": {"type": "string"},
                        },
                        "required": ["name", "operational_meaning", "insight", "recommended_action"],
                    }},
                    "overall_recommendation": {"type": "string"},
                    "next_metrics": {"type": "array", "minItems": 3, "maxItems": 3, "items": {
                        "type": "object", "properties": {"metric": {"type": "string"}, "success_signal": {"type": "string"}},
                        "required": ["metric", "success_signal"],
                    }},
                },
                "required": ["weekly_summary", "weekly_tasks", "funnel_guide", "channel_note", "type_summary_intro",
                             "type_priority_action", "commerce_summary", "customer_types", "overall_recommendation", "next_metrics"],
            },
        },
    }).encode("utf-8")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    for attempt in range(3):
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                result = _extract_gemini_json(json.loads(response.read()))
                result["source"] = "gemini"
                print(f"[report] Gemini 주간 해석 적용 ({GEMINI_MODEL})", flush=True)
                return result
        except urllib.error.HTTPError as error:
            print(f"[report] Gemini HTTP {error.code} (시도 {attempt + 1}/3)", flush=True)
            if error.code not in (429, 500, 502, 503, 504):
                break
        except Exception as error:
            print(f"[report] Gemini 응답 처리 실패 (시도 {attempt + 1}/3): {error}", flush=True)
        if attempt < 2:
            time.sleep((attempt + 1) * 2)
    print("[report] Gemini 호출 실패 - 규칙 기반 문구로 대체", flush=True)
    return {}


def ai_for_profile(inputs: dict, profile: dict, position: int) -> dict:
    entries = (inputs.get("ai") or {}).get("customer_types") or []
    name = str(profile.get("name") or "")
    return next((item for item in entries if str(item.get("name") or "") == name), entries[position] if position < len(entries) else {})


def purchase_likelihoods(profiles: list[dict]) -> list[str]:
    """Relative, reproducible purchase-intent grade from observed actions only."""
    scores = []
    for profile in profiles:
        score = 0.0
        for item in profile.get("top_actions") or []:
            action = str(item.get("action") or "").upper()
            count = int(item.get("count") or 0)
            if any(key in action for key in ("PURCHASE", "ORDER", "CHECKOUT", "GUEST_PURCHASE")):
                weight = 5.0
            elif any(key in action for key in ("ADD_TO_CART", "CART", "OPTION_SELECT")):
                weight = 3.0
            elif any(key in action for key in ("CHECK_PRICE", "CHECK_SIZE", "CHECK_SHIPPING", "VIEW_REVIEW", "REVIEW_")):
                weight = 1.5
            elif "VIEW_PRODUCT" in action or "ZOOM_IMAGE" in action:
                weight = 0.7
            else:
                weight = 0.0
            score += count * weight
        scores.append(score / max(int(profile.get("count") or 0), 1))
    average = sum(scores) / len(scores) if scores else 0
    if average <= 0:
        return ["낮음"] * len(profiles)
    return ["높음" if score >= average * 1.2 else "낮음" if score <= average * 0.6 else "중간" for score in scores]


def top_action_text(profile: dict, limit: int = 2) -> str:
    actions = profile.get("top_actions") or []
    return " · ".join(str(item.get("label") or item.get("action") or "") for item in actions[:limit]) or "관측 행동 부족"


def report_channels(channels: list[dict], limit: int = 6) -> list[dict]:
    """Keep channel names from data and combine overflow so the fixed page remains legible."""
    if len(channels) <= limit:
        return channels
    keep = channels[:limit - 1]
    rest = {"name": "기타", "sessions": 0, "product_sessions": 0, "cart_sessions": 0, "orders": 0}
    for item in channels[limit - 1:]:
        for key in ("sessions", "product_sessions", "cart_sessions", "orders"):
            rest[key] += int(item.get(key) or 0)
    return [*keep, rest]


def load_exit_hotspots(start: str, end: str, origin: str) -> list[dict]:
    capture_dir = ROOT / "ml" / "output" / "reports" / "exit_captures"
    cache_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", f"{display_site(origin)}_{start}_{end}") + ".json"
    cache_path = capture_dir / cache_name
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached and all(not item.get("capture_path") or Path(item["capture_path"]).exists() for item in cached):
                print(f"[report] 이탈 화면 캐시 사용 ({len(cached)}개)", flush=True)
                return cached
        except Exception:
            pass
    try:
        try:
            from exit_capture import capture_exit_hotspots
        except ImportError:
            from ml.exit_capture import capture_exit_hotspots
        hotspots = capture_exit_hotspots(str(ROOT / "ml"), str(capture_dir), start, end, limit=3, origin=origin)
        serializable = [{k: v for k, v in item.items() if k != "capture_b64"} for item in hotspots]
        if serializable:
            capture_dir.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(serializable, ensure_ascii=False, indent=2), encoding="utf-8")
        return serializable
    except Exception as error:
        print(f"[report] 이탈 화면 집계 실패 - 요약 지표로 대체: {error}", flush=True)
        return []


def profile_order(profiles: list[dict]) -> list[dict]:
    keywords = ["짧은 방문", "가격 확인", "상호작용", "리뷰", "카테고리"]
    ordered = []
    for keyword in keywords:
        match = next((p for p in profiles if keyword in p.get("name", "")), None)
        if match:
            ordered.append(match)
    ordered.extend(p for p in profiles if p not in ordered)
    return ordered[:5]


def pct(value: int, total: int) -> int:
    return round(value / total * 100) if total else 0


def rate(value: int, total: int) -> float:
    return round(value / total * 100, 1) if total else 0.0


def rate_text(value: float) -> str:
    return f"{value:.1f}%"


def delta_text(current: float, previous: float, suffix: str = "%p") -> str:
    delta = round(current - previous, 1)
    if delta > 0:
        return f"▲ {abs(delta):.1f}{suffix}"
    if delta < 0:
        return f"▼ {abs(delta):.1f}{suffix}"
    return f"- 0.0{suffix}"


def rate_delta_text(delta: float) -> str:
    rounded = round(delta, 1)
    if rounded > 0:
        return f"▲ {abs(rounded):.1f}%p"
    if rounded < 0:
        return f"▼ {abs(rounded):.1f}%p"
    return "- 0.0%p"


def replace_first_conic(page: str, colors: list[str], values: list[int]) -> str:
    total = sum(values) or 1
    cursor = 0.0
    stops = []
    for color, value in zip(colors, values):
        end = cursor + value / total * 100
        stops.append(f"{color} {cursor:.1f}% {end:.1f}%")
        cursor = end
    return re.sub(r"conic-gradient\([^)]*\)", f"conic-gradient({','.join(stops)})", page, count=1)


def set_style_value(tag, key: str, value: str) -> None:
    style = tag.get("style", "")
    if re.search(rf"(?:^|;)\s*{re.escape(key)}\s*:", style):
        style = re.sub(rf"({re.escape(key)}\s*:)\s*[^;]+", rf"\g<1>{value}", style)
    else:
        style = f"{style};{key}:{value}"
    tag["style"] = style


def update_bar_group(soup, heading: str, items: list[dict]) -> None:
    title = next((tag for tag in soup.find_all(["h2", "h3"]) if tag.get_text(" ", strip=True) == heading), None)
    if not title:
        return
    container = title.find_next_sibling("div")
    if not container:
        return
    rows = container.find_all("div", recursive=False)
    maximum = max((int(item.get("sessions") or item.get("count") or item.get("views") or 0) for item in items), default=1) or 1
    for row, item in zip(rows, items):
        children = row.find_all("div", recursive=False)
        if len(children) < 3:
            continue
        value = int(item.get("sessions") or item.get("count") or item.get("views") or 0)
        children[0].string = str(item.get("label") or item.get("name") or "-")
        suffix = "회" if children[-1].get_text(strip=True).endswith("회") else ""
        children[-1].string = f"{value}{suffix}"
        bar = children[1].find("div")
        if bar:
            set_style_value(bar, "width", f"{value / maximum * 100:.1f}%")


def bind_weekly_data(page: str, source_index: int, inputs: dict) -> str:
    metrics = inputs.get("metrics") or {}
    commerce = inputs.get("commerce") or {}
    profiles = profile_order(inputs.get("profiles") or [])
    overview = metrics.get("overview") or {}
    previous = metrics.get("prev_overview") or {}
    sessions = int(overview.get("sessions") or 0)
    profile_total = sum(int(p.get("count") or 0) for p in profiles)
    if not sessions:
        sessions = profile_total

    # Marketing overview pages use the same baseline values as the supplied design.
    if source_index in {5, 6, 7, 8, 9} and overview:
        replacements = {
            "234": str(sessions), "242": str(previous.get("sessions", 0)),
            "122": str(overview.get("product_sessions", 0)),
            "114": str(overview.get("product_sessions", 0)),
            "105": str(overview.get("product_sessions", 0)),
        }
        for old, new in replacements.items():
            page = re.sub(rf"(?<!\d){re.escape(old)}(?!\d)", new, page)

    if source_index == 5 and overview:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        ai = inputs.get("ai") or {}
        intro = soup.find("h1").find_next_sibling("p") if soup.find("h1") else None
        if intro and ai.get("weekly_summary"):
            intro.string = str(ai["weekly_summary"])
        orders = int(overview.get("orders") or 0)
        cart_sessions = int(overview.get("cart_sessions") or 0)
        prev_sessions = int(previous.get("sessions") or 0)
        prev_orders = int(previous.get("orders") or 0)
        prev_cart = int(previous.get("cart_sessions") or 0)
        order_rate = rate(orders, sessions)
        prev_order_rate = rate(prev_orders, prev_sessions)
        cart_rate = rate(cart_sessions, sessions)
        prev_cart_rate = rate(prev_cart, prev_sessions)
        raw_order_delta = (orders / sessions * 100 if sessions else 0) - (prev_orders / prev_sessions * 100 if prev_sessions else 0)
        raw_cart_delta = (cart_sessions / sessions * 100 if sessions else 0) - (prev_cart / prev_sessions * 100 if prev_sessions else 0)
        summary_kpis = {
            "방문 세션": str(sessions), "주문 완료": f"{orders}건",
            "주문 전환율": rate_text(order_rate), "장바구니 도달률": rate_text(cart_rate),
        }
        for label, value in summary_kpis.items():
            label_tag = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == label), None)
            if label_tag:
                number = label_tag.find_next_sibling("div")
                if number:
                    number.string = value
                note = number.find_next_sibling("div") if number else None
                if note and label == "방문 세션":
                    note.string = f"변화 작음 (전주 {prev_sessions})"
                elif note and label == "주문 완료":
                    note.string = f"변화 작음 (전주 {prev_orders}건)"
                elif note and label == "주문 전환율":
                    note.string = f"{rate_delta_text(raw_order_delta)} (전주 {rate_text(prev_order_rate)})"
                elif note and label == "장바구니 도달률":
                    note.string = f"{rate_delta_text(raw_cart_delta)} (전주 {rate_text(prev_cart_rate)})"
        product_sessions = int(overview.get("product_sessions") or 0)
        stopped = max(product_sessions - cart_sessions, 0)
        progress = rate(cart_sessions, product_sessions)
        action_blocks = [tag for tag in soup.find_all("div") if "상품 조회" in tag.get_text(" ", strip=True) and "명 중" in tag.get_text(" ", strip=True)]
        if action_blocks:
            block = action_blocks[0]
            html = str(block)
            html = re.sub(r"상품 조회 \d+명 중 \d+명만 다음 단계로 갔습니다 \([^)]*\)",
                          f"상품 조회 {product_sessions}명 중 {cart_sessions}명만 다음 단계로 갔습니다 ({progress:.1f}%, {stopped}명 멈춤)", html)
            block.replace_with(__import__("bs4").BeautifulSoup(html, "html.parser").find())
        next_check = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True).startswith("다음 주 확인: 장바구니 진행률")), None)
        if next_check:
            next_check.string = f"다음 주 확인: 장바구니 진행률 {progress:.1f}% → 변화"
        task_heading = next((tag for tag in soup.find_all("h2") if tag.get_text(strip=True) == "이번 주 할 일"), None)
        tasks = ai.get("weekly_tasks") or []
        if task_heading and tasks:
            cards = task_heading.find_next_siblings("div", limit=len(tasks))
            for index, (card, task) in enumerate(zip(cards, tasks), 1):
                children = card.find_all("div", recursive=False)
                if children:
                    children[0].string = f"{index}. {task.get('title', '이번 주 할 일')}"
                if len(children) > 1:
                    children[1].clear()
                    reason_label = soup.new_tag("b")
                    reason_label.string = "근거"
                    action_label = soup.new_tag("b")
                    action_label.string = "할 일"
                    children[1].extend([reason_label, f" {task.get('reason', '')}", soup.new_tag("br"), action_label, f" {task.get('action', '')}"])
        traffic_heading = next((tag for tag in soup.find_all("h2") if "방문이 몰리는 시간" in tag.get_text()), None)
        traffic_chart = traffic_heading.find_next_sibling("div") if traffic_heading else None
        hourly = [int(value or 0) for value in (metrics.get("hourly") or [0] * 24)][:24]
        hourly += [0] * (24 - len(hourly))
        weekdays = [int(value or 0) for value in (metrics.get("weekday") or [0] * 7)][:7]
        weekdays += [0] * (7 - len(weekdays))
        if traffic_chart:
            groups = traffic_chart.find_all("div", recursive=False)
            hour_rows = groups[0].find_all("div", recursive=False) if groups else []
            day_rows = groups[1].find_all("div", recursive=False) if len(groups) > 1 else []
            peak_hour_bucket = max(range(8), key=lambda index: sum(hourly[index * 3:index * 3 + 3]))
            for hour, (row, value) in enumerate(zip(hour_rows, hourly)):
                bar = row.find("div", recursive=False)
                if bar:
                    set_style_value(bar, "height", f"{max(value / max(max(hourly), 1) * 95, 3):.1f}px")
                    set_style_value(bar, "background", "#e0852a" if hour // 3 == peak_hour_bucket else "#9fb4e6")
            peak_day = max(range(7), key=lambda index: weekdays[index])
            for index, (row, value) in enumerate(zip(day_rows, weekdays)):
                bar = row.find("div", recursive=False)
                if bar:
                    set_style_value(bar, "height", f"{max(value / max(max(weekdays), 1) * 95, 3):.1f}px")
                    set_style_value(bar, "background", "#e0852a" if index == peak_day else "#9fb4e6")
            summary = traffic_chart.find_next_sibling("p")
            if summary:
                bucket_value = sum(hourly[peak_hour_bucket * 3:peak_hour_bucket * 3 + 3])
                summary.string = (
                    f"방문은 {peak_hour_bucket * 3}~{peak_hour_bucket * 3 + 3}시에 가장 몰립니다"
                    f"(전체의 {pct(bucket_value, sum(hourly))}%). 요일은 "
                    f"{['월요일','화요일','수요일','목요일','금요일','토요일','일요일'][peak_day]}"
                    f"({pct(weekdays[peak_day], sum(weekdays))}%)이 가장 많습니다. 운영 메시지는 이 시간 전후로 시험해 보세요."
                )
        page = str(soup)

    if source_index == 6 and overview and previous:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        prev_sessions = int(previous.get("sessions") or 0)
        current_orders, prev_orders = int(overview.get("orders") or 0), int(previous.get("orders") or 0)
        current_cart, prev_cart = int(overview.get("cart_sessions") or 0), int(previous.get("cart_sessions") or 0)
        current_product, prev_product = int(overview.get("product_sessions") or 0), int(previous.get("product_sessions") or 0)
        current_order_rate, prev_order_rate = rate(current_orders, sessions), rate(prev_orders, prev_sessions)
        current_cart_rate, prev_cart_rate = rate(current_cart, sessions), rate(prev_cart, prev_sessions)
        current_product_rate, prev_product_rate = rate(current_product, sessions), rate(prev_product, prev_sessions)
        rows_data = [
            ("방문 세션", str(sessions), str(prev_sessions), sessions - prev_sessions, "count"),
            ("주문 완료", f"{current_orders}건", f"{prev_orders}건", current_orders - prev_orders, "orders"),
            ("주문 전환율", rate_text(current_order_rate), rate_text(prev_order_rate),
             (current_orders / sessions * 100 if sessions else 0) - (prev_orders / prev_sessions * 100 if prev_sessions else 0), "rate"),
            ("장바구니 도달률", rate_text(current_cart_rate), rate_text(prev_cart_rate),
             (current_cart / sessions * 100 if sessions else 0) - (prev_cart / prev_sessions * 100 if prev_sessions else 0), "rate"),
            ("상품 조회 진행률", rate_text(current_product_rate), rate_text(prev_product_rate),
             (current_product / sessions * 100 if sessions else 0) - (prev_product / prev_sessions * 100 if prev_sessions else 0), "rate"),
        ]
        verdicts = []
        table = soup.find("sc-raw-table")
        if table:
            rows = table.find_all("sc-raw-tr")[1:]
            for row, (label, current, prev, delta, kind) in zip(rows, rows_data):
                cells = row.find_all("sc-raw-td")
                if kind == "count":
                    change = f"{'▲' if delta > 0 else '▼' if delta < 0 else '-'} {abs(int(delta))} ({abs(delta) / prev_sessions * 100:.1f}%)"
                    verdict = "변화 작음" if abs(delta) <= math.sqrt(prev_sessions or 1) else ("개선" if delta > 0 else "점검")
                elif kind == "orders":
                    change = f"{'▲' if delta > 0 else '▼' if delta < 0 else '-'} {abs(int(delta))}건"
                    verdict = "변화 작음" if abs(delta) <= math.sqrt(prev_orders or 1) else ("개선" if delta > 0 else "점검")
                else:
                    change = rate_delta_text(delta)
                    if label == "상품 조회 진행률":
                        verdict = "상승" if delta > 0 else "하락" if delta < 0 else "변화 작음"
                    else:
                        verdict = "개선" if delta > 0 else "점검" if delta < 0 else "변화 작음"
                verdicts.append(verdict)
                values = [label, current, prev, change, verdict]
                for cell, value in zip(cells, values):
                    if cell.find(["b", "span"]):
                        cell.find(["b", "span"]).string = value
                    else:
                        cell.string = value
        counter_values = {"개선": verdicts.count("개선"), "변화 작음": verdicts.count("변화 작음"), "점검 필요": verdicts.count("점검")}
        for label, value in counter_values.items():
            label_tag = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == label), None)
            if label_tag:
                number = label_tag.find_next_sibling("div")
                if number:
                    number.string = str(value)
        chart_title = next((tag for tag in soup.find_all("h2") if "비율 지표 이번 주" in tag.get_text()), None)
        chart = chart_title.find_next_sibling("div") if chart_title else None
        chart_values = [
            (current_order_rate, prev_order_rate),
            (current_cart_rate, prev_cart_rate),
            (current_product_rate, prev_product_rate),
        ]
        if chart:
            for group, (current_value, previous_value) in zip(chart.find_all("div", recursive=False), chart_values):
                metric_box = group.find_all("div", recursive=False)
                if len(metric_box) < 2:
                    continue
                comparison_rows = metric_box[1].find_all("div", recursive=False)
                scale = max(current_value, previous_value, 0.1)
                for comparison, value in zip(comparison_rows, [current_value, previous_value]):
                    parts = comparison.find_all("div", recursive=False)
                    if len(parts) < 3:
                        continue
                    parts[-1].string = rate_text(value)
                    bar = parts[1].find("div")
                    if bar:
                        set_style_value(bar, "width", f"{value / scale * 100:.1f}%")
        guide_candidates = [tag for tag in soup.find_all("div") if "전주와의 차이가 우연 수준" in tag.get_text(" ", strip=True)]
        guide = min(guide_candidates, key=lambda tag: len(str(tag))) if guide_candidates else None
        if guide:
            guide.clear()
            guide.append(
                "전주와의 차이가 우연 수준(건수의 제곱근 이내)이면 변화 작음으로 봐요. "
                "주문 전환율과 장바구니 도달률은 전주보다 낮아졌고, 상품 조회 진행률은 높아졌어요. "
                "원인은 데이터만으로 확정할 수 없어요."
            )
        page = str(soup)

    if source_index == 7 and overview:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        weekday_values = [int(value or 0) for value in (metrics.get("weekday") or [0] * 7)][:7]
        weekday_values += [0] * (7 - len(weekday_values))
        hourly = [int(value or 0) for value in (metrics.get("hourly") or [0] * 24)][:24]
        hourly += [0] * (24 - len(hourly))
        day_names = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"]
        short_names = ["월", "화", "수", "목", "금", "토", "일"]
        total = sum(weekday_values) or sessions or 1
        shares = [value / total * 100 for value in weekday_values]
        max_day = max(range(7), key=lambda index: weekday_values[index])
        min_day = min(range(7), key=lambda index: weekday_values[index])
        buckets = [sum(hourly[start:start + 3]) for start in range(0, 24, 3)]
        peak_bucket = max(range(8), key=lambda index: buckets[index])
        peak_label = f"{peak_bucket * 3}~{peak_bucket * 3 + 3}시"
        peak_share = buckets[peak_bucket] / max(sum(hourly), 1) * 100
        kpis = {
            "가장 많은 요일": f"{day_names[max_day]} {shares[max_day]:.0f}%",
            "방문이 몰리는 시간": f"{peak_label} {peak_share:.0f}%",
            "가장 적은 요일": f"{day_names[min_day]} {shares[min_day]:.0f}%",
        }
        for label, value in kpis.items():
            tag = next((node for node in soup.find_all("div") if node.get_text(strip=True) == label), None)
            if tag:
                target = tag.find_next_sibling("div")
                if target:
                    target.string = value
        for day_index, (short, share) in enumerate(zip(short_names, shares)):
            day_tag = next((node for node in soup.find_all("div") if node.get_text(strip=True) == short), None)
            if day_tag:
                for percent_tag in day_tag.parent.find_all("div") if day_tag.parent else []:
                    if re.fullmatch(r"\d+(?:\.\d+)?%", percent_tag.get_text(strip=True)):
                        percent_tag.string = f"{share:.0f}%"
                candidates = day_tag.parent.find_all("div", recursive=False) if day_tag.parent else []
                if len(candidates) >= 2:
                    set_style_value(candidates[0], "height", "auto")
                    set_style_value(candidates[1], "height", f"{max(share / max(max(shares), 1) * 140, 4):.1f}px")
                    set_style_value(candidates[1], "background", "#e0852a" if day_index == max_day else "#9fb4e6")
        weekday_share = sum(weekday_values[:5]) / total * 100
        weekend_share = sum(weekday_values[5:]) / total * 100
        for label, value in (("평일", weekday_share), ("주말", weekend_share)):
            node = next((tag for tag in soup.find_all("div") if tag.get_text(" ", strip=True).startswith(label + " ") and "%" in tag.get_text()), None)
            if node:
                node.string = f"{label} {value:.0f}%"
        suggestion_label = next((tag for tag in soup.find_all("span") if tag.get_text(strip=True) == "활용 제안"), None)
        suggestion = suggestion_label.find_next_sibling("div") if suggestion_label else None
        if suggestion:
            suggestion.string = (
                f"방문이 가장 많은 {day_names[max_day]}과 {peak_label} 전후에 운영 메시지를 시험해 보세요. "
                "방문이 많은 시간이 주문이 많은 시간과 같다고 단정할 수 없으므로 다음 주 주문 변화를 함께 확인하세요."
            )
        estimate_note = next((tag for tag in soup.find_all("p") if "요약 페이지 차트 기준 추정" in tag.get_text()), None)
        if estimate_note:
            estimate_note.string = "전체 방문 대비 실제 요일별 비중"
        page = str(soup)

    if source_index == 8 and overview:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        funnel = metrics.get("funnel") or []
        for position, item in enumerate(funnel):
            label = item.get("stage")
            label_tag = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == label), None)
            if not label_tag or not label_tag.parent:
                continue
            row = label_tag.parent
            count = int(item.get("sessions") or 0)
            share = pct(count, sessions)
            children = row.find_all("div", recursive=False)
            if len(children) >= 3:
                children[-1].string = f"{count}명 ({share}%)"
                bar = children[1].find("div")
                if bar:
                    set_style_value(bar, "width", f"{max(share, 1)}%")
            transition = row.find_next_sibling("div")
            if transition and position + 1 < len(funnel):
                next_count = int(funnel[position + 1].get("sessions") or 0)
                transition.string = f"▼ {pct(next_count, count)}% 진행 · {max(count - next_count, 0)}명 멈춤"
        tables = soup.find_all("sc-raw-table")
        devices = metrics.get("devices") or []
        if tables and devices:
            rows = tables[0].find_all("sc-raw-tr")[1:]
            for row, item in zip(rows, devices):
                cells = row.find_all("sc-raw-td")
                total = int(item.get("sessions") or 0)
                cart = int(item.get("cart_sessions") or 0)
                orders = int(item.get("orders") or 0)
                values = [item.get("name") or "-", total, f"{pct(cart, total)}%", f"{pct(orders, total)}%", f"{orders}건"]
                for cell, value in zip(cells, values):
                    cell.string = str(value)
        update_bar_group(soup, "고객이 마지막에 머문 화면", metrics.get("exit_pages") or [])
        update_bar_group(soup, "멈춘 흔적(추정)", metrics.get("exit_causes") or [])
        if len(funnel) >= 2:
            visits = int(funnel[0].get("sessions") or 0)
            product_visits = int(funnel[1].get("sessions") or 0)
            progress = rate(product_visits, visits)
            stopped = max(visits - product_visits, 0)
            prev_visits = int(previous.get("sessions") or 0)
            prev_products = int(previous.get("product_sessions") or 0)
            prev_progress = rate(prev_products, prev_visits)
            label = next((tag for tag in soup.find_all("span") if tag.get_text(strip=True) == "읽는 법"), None)
            guide = label.find_next_sibling("div") if label else None
            if guide:
                direction = "좋아졌어요" if progress > prev_progress else "낮아졌어요" if progress < prev_progress else "같아요"
                guide_html = (
                    f"가장 많이 멈춘 구간은 <b>방문 → 상품 조회</b>({stopped}명, 진행률 {progress:.0f}%)예요. "
                    f"전주 {prev_progress:.0f}% → {progress:.0f}%로 {direction}. "
                    "홈 첫 화면에서 대표 상품·혜택으로 바로 이어지는지(배너 문구, 추천 상품 영역) 점검하세요. "
                    "각 단계는 그 화면 또는 그 이후에 도달한 세션 수예요."
                )
                replacement = __import__("bs4").BeautifulSoup(f"<div>{guide_html}</div>", "html.parser").div
                replacement["style"] = guide.get("style", "")
                guide.replace_with(replacement)
            if guide and (inputs.get("ai") or {}).get("funnel_guide"):
                replacement.string = str(inputs["ai"]["funnel_guide"])
        page = str(soup)

    if source_index == 9 and overview:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        channels = report_channels(metrics.get("channels") or [])
        tables = soup.find_all("sc-raw-table")
        if tables and channels:
            rows = tables[0].find_all("sc-raw-tr")[1:]
            for row, item in zip(rows, channels):
                cells = row.find_all("sc-raw-td")
                count = int(item.get("sessions") or 0)
                product = int(item.get("product_sessions") or 0)
                cart = int(item.get("cart_sessions") or 0)
                orders = int(item.get("orders") or 0)
                name = str(item.get("name") or "-")
                values = [name, f"{count} ({count / sessions * 100:.1f}%)", f"{pct(product, count)}%",
                          f"{pct(cart, count)}%", f"{pct(orders, count)}% ({orders}건)",
                          "주문 없음" if count >= 20 and not orders else "표본 적음"]
                for cell, value in zip(cells, values):
                    cell.clear()
                    cell.append(str(value))
            for row in rows[len(channels):]:
                set_style_value(row, "display", "none")
        total_orders = sum(int(item.get("orders") or 0) for item in channels)
        chart_title = next((tag for tag in soup.find_all("h2") if tag.get_text(strip=True) == "방문 비중 대 주문 비중"), None)
        legend = chart_title.find_next_sibling("div") if chart_title else None
        chart = legend.find_next_sibling("div") if legend else None
        chart_rows = chart.find_all("div", recursive=False) if chart else []
        for item, row in zip(channels, chart_rows):
            name = str(item.get("name") or "-")
            parts = row.find_all("div", recursive=False)
            if len(parts) < 2:
                continue
            parts[0].string = name
            metric_rows = parts[1].find_all("div", recursive=False)
            shares = [int(item.get("sessions") or 0) / sessions * 100,
                      int(item.get("orders") or 0) / total_orders * 100 if total_orders else 0]
            for metric_row, share in zip(metric_rows, shares):
                metric_parts = metric_row.find_all("div", recursive=False)
                if len(metric_parts) < 3:
                    continue
                metric_parts[-1].string = f"{share:.1f}%" if 0 < share < 10 else f"{share:.0f}%"
                bar = metric_parts[1].find("div")
                if bar:
                    set_style_value(bar, "width", f"{share:.1f}%")
        for row in chart_rows[len(channels):]:
            set_style_value(row, "display", "none")
        direct = next((item for item in channels if str(item.get("name") or "").strip() in {"직접 방문", "Direct", "direct"}), None)
        lead = direct or (channels[0] if channels else {})
        direct_share = pct(int(lead.get("sessions") or 0), sessions) if lead else 0
        intro = next((tag for tag in soup.find_all("p") if "직접 방문" in tag.get_text()), None)
        if intro:
            intro.string = f"방문의 {direct_share}%가 {lead.get('name', '대표 채널')}이고, 이번 주는 주문이 {'있어요.' if overview.get('orders') else '없어요.'}"
        note = next((tag for tag in soup.find_all("p") if "파란 막대" in tag.get_text()), None)
        if note and (inputs.get("ai") or {}).get("channel_note"):
            note.string = str(inputs["ai"]["channel_note"])
        page = str(soup)

    # Customer-type overview and five detail pages.
    if source_index == 10 and profiles:
        old_counts = [110, 33, 19, 17, 7]
        old_shares = [59, 18, 10, 9, 4]
        colors = ["#332288", "#44AA99", "#DDCC77", "#CC6677", "#88CCEE"]
        for old, profile in zip(old_counts, profiles):
            page = re.sub(rf"(?<!\d){old}(?!\d)", str(profile["count"]), page)
        for old, profile in zip(old_shares, profiles):
            page = page.replace(f"{old}%", f"{pct(profile['count'], profile_total)}%")
        page = page.replace("186", str(profile_total))
        page = replace_first_conic(page, colors, [p["count"] for p in profiles])
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        likelihoods = purchase_likelihoods(profiles)
        high_visits = sum(int(profile.get("count") or 0) for profile, grade in zip(profiles, likelihoods) if grade == "높음")
        high_label = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == "구매 가능성 높은 방문"), None)
        if high_label:
            high_value = high_label.find_next_sibling("div")
            if high_value:
                high_value.string = f"{pct(high_visits, profile_total)}%"
        intro = soup.find("h1").find_next_sibling("p") if soup.find("h1") else None
        if intro:
            intro.string = str((inputs.get("ai") or {}).get("type_summary_intro") or f"가장 많은 고객은 {profiles[0].get('name', '첫 번째 유형')}이에요.")
        priority = next((tag for tag in soup.find_all("b") if tag.get_text(strip=True) == "우선 조치"), None)
        if priority and priority.parent:
            priority_box = priority.parent
            priority_box.clear()
            label = soup.new_tag("b")
            label.string = "우선 조치"
            priority_box.extend([label, " · ", str((inputs.get("ai") or {}).get("type_priority_action") or profiles[0].get("action") or "")])
        legend_rows = [tag for tag in soup.find_all("div") if tag.find("span", recursive=False) and tag.find("b", recursive=False)]
        for row, profile in zip(legend_rows[:5], profiles):
            spans = row.find_all("span", recursive=False)
            if len(spans) >= 2:
                spans[1].string = str(profile.get("name") or "고객 유형")
            row.find("b", recursive=False).string = f"{pct(profile['count'], profile_total)}% · {profile['count']}건"
            set_style_value(row, "width", "330px")
            set_style_value(row, "font-size", "11.5px")
            children = row.find_all(recursive=False)
            if len(children) > 1:
                set_style_value(children[1], "white-space", "nowrap")
        if legend_rows:
            set_style_value(legend_rows[0].parent, "width", "340px")
        table = soup.find("sc-raw-table")
        if table:
            for row, profile, likelihood in zip(table.find_all("sc-raw-tr")[1:], profiles, likelihoods):
                cells = row.find_all("sc-raw-td")
                if len(cells) >= 5:
                    cells[0].string = str(profile.get("name") or "고객 유형")
                    cells[1].string = f"{profile['count']}건"
                    cells[2].string = f"{pct(profile['count'], profile_total)}%"
                    badge = cells[3].find("span")
                    if badge:
                        badge.string = likelihood
                    else:
                        cells[3].string = likelihood
                    cells[4].string = top_action_text(profile)
        page = str(soup)

    detail_baselines = {
        13: (0, 110, 59), 14: (1, 33, 18), 15: (2, 19, 10),
        16: (3, 17, 9), 17: (4, 7, 4),
    }
    if source_index in detail_baselines and profiles:
        position, old_count, old_share = detail_baselines[source_index]
        if position < len(profiles):
            profile = profiles[position]
            ai_profile = ai_for_profile(inputs, profile, position)
            likelihood = purchase_likelihoods(profiles)[position]
            soup = __import__("bs4").BeautifulSoup(page, "html.parser")
            title = soup.find("h1")
            if not title:
                root = soup.find("x-dc").find("div", recursive=False) if soup.find("x-dc") else None
                if root:
                    fragment = __import__("bs4").BeautifulSoup(
                        '<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #17407a;padding-bottom:14px">'
                        '<div style="font-size:13px;font-weight:700;letter-spacing:2px;color:#17407a">SEER ANALYTICS</div>'
                        '<div style="font-size:13px;color:#4a5670">2026.10.21 – 10.27</div></div>'
                        '<h1 style="margin:30px 0 6px;font-size:28px;font-weight:900;color:#17407a">고객 유형 상세 분석</h1>',
                        "html.parser",
                    )
                    for node in reversed(list(fragment.contents)):
                        root.insert(0, node)
                    title = soup.find("h1")
            subtitle = title.find_next_sibling("p") if title else None
            if subtitle:
                subtitle.string = str(ai_profile.get("operational_meaning") or profile.get("action") or profile.get("summary") or "이 유형에 맞춘 운영 조치가 필요해요.")
                set_style_value(subtitle, "margin", "0 0 12px")
            elif title:
                subtitle = soup.new_tag("p")
                subtitle["style"] = "margin:0 0 12px;font-size:15px;color:#4a5670"
                subtitle.string = str(ai_profile.get("operational_meaning") or profile.get("action") or profile.get("summary") or "이 유형에 맞춘 운영 조치가 필요해요.")
                title.insert_after(subtitle)
            banner = subtitle.find_next_sibling("div") if subtitle else None
            if banner:
                set_style_value(banner, "margin-top", "0")
                set_style_value(banner, "height", "82px")
                set_style_value(banner, "padding", "12px 24px")
                set_style_value(banner, "box-sizing", "border-box")
                set_style_value(banner, "margin-bottom", "12px")
            evidence_title = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == "이 유형으로 분류한 근거"), None)
            if evidence_title:
                evidence = evidence_title.find_next_sibling("div")
                if evidence:
                    page_items = sorted((profile.get("page_dist") or {}).items(), key=lambda item: -int(item[1]))[:3]
                    evidence.string = (
                        f"총 {profile.get('count', 0)}건 · 주요 행동 {top_action_text(profile, 3)} · "
                        f"주요 페이지 {', '.join(f'{name} {count}회' for name, count in page_items) or '관측 정보 부족'}"
                    )
            likelihood_text = next((tag for tag in soup.find_all(["div", "span"]) if "구매 가능성" in tag.get_text(" ", strip=True) and tag.get_text(" ", strip=True) in {"구매 가능성 높음", "구매 가능성 중간", "구매 가능성 낮음"}), None)
            if likelihood_text:
                likelihood_text.string = f"구매 가능성 {likelihood}"
            insight_label = next((tag for tag in soup.find_all(["span", "div"]) if tag.get_text(" ", strip=True) == "AI 분석 인사이트"), None)
            if insight_label and ai_profile.get("insight"):
                insight_box = next(iter(insight_label.parent.find_all("div", recursive=False)), None) if insight_label.parent else None
                if insight_box:
                    insight_box.string = f"{ai_profile['insight']} {ai_profile.get('recommended_action') or profile.get('action') or '다음 주 실행 조치를 점검하세요.'}"
                    set_style_value(insight_box, "font-size", "13.5px")
                    set_style_value(insight_box, "line-height", "1.65")
            action_heading = next((tag for tag in soup.find_all(["h2", "h3", "div"]) if tag.get_text(" ", strip=True).startswith("주요 행동 TOP") and len(tag.get_text(" ", strip=True)) < 20), None)
            action_group = action_heading.find_next_sibling("div") if action_heading else None
            actions = profile.get("top_actions") or []
            if action_group:
                rows = action_group.find_all("div", recursive=False)
                maximum = max((int(item.get("count") or 0) for item in actions[:7]), default=1) or 1
                for row, item in zip(rows, actions[:7]):
                    parts = row.find_all("div", recursive=False)
                    if len(parts) >= 3:
                        value = int(item.get("count") or 0)
                        parts[0].string = str(item.get("label") or item.get("action") or "행동")
                        parts[-1].string = f"{value}회"
                        bar = parts[1].find("div")
                        if bar:
                            set_style_value(bar, "width", f"{value / maximum * 100:.1f}%")
                for row in rows[len(actions[:7]):]:
                    set_style_value(row, "display", "none")
            page_dist = profile.get("page_dist") or {}
            page_labels = {
                "PRODUCT": "상품 상세", "HOME": "홈 화면", "CATEGORY": "카테고리", "SEARCH": "검색",
                "CART": "장바구니", "CHECKOUT": "결제", "ORDER_SUCCESS": "주문 완료", "REVIEW": "리뷰",
                "BOARD": "게시판", "MYPAGE": "마이페이지", "MEMBER": "회원", "UNKNOWN": "기타·미분류",
            }
            detail_palettes = [
                ["#332288", "#7064AC", "#9990C4", "#BEB8D9", "#DAD7EA"],
                ["#168477", "#44AA99", "#76C4B8", "#A8DED5", "#D7F0EC"],
                ["#A07800", "#C6A83B", "#DDCC77", "#EADFAD", "#F4EED5"],
                ["#A73E50", "#CC6677", "#D98D99", "#E7B6BE", "#F4DDE1"],
                ["#167AA6", "#4CA8CE", "#88CCEE", "#B1DDF1", "#DCEFF8"],
            ]
            sorted_pages = sorted(page_dist.items(), key=lambda item: -int(item[1]))[:5]
            top_page_label = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == "주요 페이지"), None)
            if top_page_label:
                value = top_page_label.find_next_sibling("div")
                if value:
                    value.string = ", ".join(page_labels.get(str(name), str(name)) for name, _ in sorted_pages[:3])
            top_action_label = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == "TOP 행동"), None)
            if top_action_label:
                value = top_action_label.find_next_sibling("div")
                if value:
                    value.string = top_action_text(profile, 3)
            legend_rows = []
            for row in soup.find_all("div"):
                children = row.find_all(recursive=False)
                if len(children) == 3 and children[0].name == "span" and children[1].name == "span" and children[2].name == "b":
                    legend_rows.append(row)
            total_pages = sum(int(value) for _, value in sorted_pages) or 1
            if legend_rows:
                legend_parent = legend_rows[0].parent
                template_row = legend_rows[0]
                for row in legend_rows:
                    row.extract()
                for index, (name, value) in enumerate(sorted_pages):
                    row = copy.copy(template_row)
                    children = row.find_all(recursive=False)
                    color = detail_palettes[position][index]
                    set_style_value(children[0], "background", color)
                    children[1].string = page_labels.get(str(name), str(name))
                    children[2].string = f"{pct(int(value), total_pages)}%"
                    set_style_value(row, "display", "flex")
                    set_style_value(row, "width", "118px")
                    legend_parent.append(row)
                pie_title = next((
                    tag for tag in soup.find_all("div")
                    if tag.get_text(strip=True) == "페이지별 방문 비율" and not tag.find("div")
                ), None)
                pie_panel = pie_title.parent if pie_title else None
                if pie_panel:
                    set_style_value(pie_panel, "display", "flex")
                    set_style_value(pie_panel, "flex-direction", "column")
                    set_style_value(pie_panel, "align-items", "center")
                    set_style_value(pie_panel, "width", "270px")
                    set_style_value(pie_panel, "height", "260px")
                    set_style_value(pie_panel, "flex", "none")
                    set_style_value(pie_title, "width", "260px")
                    chart_holder = pie_title.find_next_sibling("div")
                    if chart_holder:
                        set_style_value(chart_holder, "width", "260px")
                        set_style_value(chart_holder, "height", "150px")
                        set_style_value(chart_holder, "gap", "0")
                    legend_grid = soup.new_tag("div")
                    legend_grid["style"] = "display:flex;width:250px;gap:10px;margin:2px auto 0;align-items:flex-start"
                    left_column = soup.new_tag("div")
                    left_column["style"] = "display:flex;flex-direction:column;gap:4px;width:120px"
                    right_column = soup.new_tag("div")
                    right_column["style"] = "display:flex;flex-direction:column;gap:4px;width:120px"
                    current_rows = list(legend_parent.find_all("div", recursive=False))
                    for index, row in enumerate(current_rows):
                        row.extract()
                        (left_column if index < 3 else right_column).append(row)
                    legend_grid.extend([left_column, right_column])
                    pie_panel.append(legend_grid)
                    legend_parent.decompose()
            page = str(soup)
            page = re.sub(rf"(?<!\d){old_count}(?!\d)", str(profile["count"]), page)
            page = re.sub(r"주요 행동 TOP\s*\d+", f"주요 행동 TOP {min(len(actions), 7)}", page)
            page = page.replace(f"{old_share}%", f"{pct(profile['count'], profile_total)}%")
            page = page.replace(
                ["짧은 방문·행동 정보 부족형", "상품·가격 확인 중심 고객", "다양한 상호작용·구매 시도 고객", "리뷰 관련 신호 중심 고객", "상품·카테고리 반복 탐색 고객"][position],
                profile.get("name", ""),
            )
            actions = profile.get("top_actions") or []
            for action in actions[:7]:
                label, count = str(action.get("label") or action.get("action") or ""), int(action.get("count") or 0)
                # Counts are rendered next to the same label; update the first matching row.
                page = re.sub(
                    rf"({re.escape(label)}.*?)(\d+)(회)",
                    lambda m: f"{m.group(1)}{count}{m.group(3)}", page, count=1,
                )
            page_dist = profile.get("page_dist") or {}
            labels = list(page_dist.keys())[:5]
            values = [int(page_dist[k]) for k in labels]
            palette = detail_palettes[position]
            page = replace_first_conic(page, palette[:len(values)], values)
            translations = {
                "Scroll Category": "카테고리 스크롤",
                "View Section": "특정 영역 확인",
                "Review Exploration Episode": "리뷰 집중 탐색",
                "Price Review Episode": "가격·리뷰 반복 확인",
                "BOARD": "게시판",
                "UNKNOWN": "기타·미분류",
            }
            for english, korean in translations.items():
                page = page.replace(english, korean)

    # Commerce page values and rows.
    if source_index == 11 and commerce:
        counts = commerce.get("counts") or {}
        products = commerce.get("products") or []
        categories = commerce.get("categories") or []
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        kpis = {
            "상품 클릭": counts.get("product_clicks", 0), "리뷰 확인": counts.get("review_views", 0),
            "카트 방문": counts.get("cart_visits", 0), "장바구니 담기": counts.get("add_to_cart", 0),
            "찜하기": counts.get("wishlist_adds", 0), "주문 완료": counts.get("order_completions", 0),
        }
        for label, value in kpis.items():
            label_tag = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == label), None)
            if label_tag:
                number = label_tag.find_next_sibling("div")
                if number:
                    number.string = str(value)
        tables = soup.find_all("sc-raw-table")
        if tables:
            rows = tables[0].find_all("sc-raw-tr")
            for row, product in zip(rows[1:], products):
                cells = row.find_all("sc-raw-td")
                if len(cells) >= 3:
                    cells[0].string = str(product.get("name") or "상품")
                    cells[1].string = str(product.get("clicks") or 0)
                    cells[2].string = str(product.get("detail_views") or 0)
            for row in rows[1 + len(products):]:
                set_style_value(row, "display", "none")
        update_bar_group(soup, "확인한 카테고리", categories)
        summary_label = next((tag for tag in soup.find_all("b") if tag.get_text(strip=True) == "수집 점검"), None)
        if summary_label and summary_label.parent:
            summary_label.string = "이번 주 요약"
            text = (inputs.get("ai") or {}).get("commerce_summary")
            if text:
                for child in list(summary_label.parent.contents):
                    if child is not summary_label:
                        child.extract()
                summary_label.parent.append(f" · {text}")
        page = str(soup)

    if source_index == 12:
        page = page.replace("탐색 중지 집중 화면", "고객이 가장 많이 나간 화면")
        page = page.replace(
            "session_end / tab_exit / inactivity를 page_url + section + scrollY로 묶어 상위 3곳을 골랐어요.",
            "고객의 탐색이 끝난 위치를 화면·영역·스크롤 위치별로 묶어 상위 3곳을 보여드려요.",
        )
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        hotspots = inputs.get("exit_hotspots") or []
        fallback = metrics.get("exit_pages") or []
        cards = [tag for tag in soup.find_all("div") if "background:#f3f5f9" in str(tag.get("style") or "") and tag.find("div", recursive=False)]
        for index, card in enumerate(cards[:3]):
            item = hotspots[index] if index < len(hotspots) else (fallback[index] if index < len(fallback) else {})
            if not item:
                continue
            count = int(item.get("count") or item.get("sessions") or 0)
            share = item.get("share")
            if share is None:
                total_exits = sum(int(x.get("count") or x.get("sessions") or 0) for x in (hotspots or fallback)) or 1
                share = round(count / total_exits * 100)
            children = card.find_all("div", recursive=False)
            header = children[0] if children else None
            if header:
                parts = header.find_all("div", recursive=False)
                if parts:
                    parts[0].clear()
                    parts[0].append(f"탐색 중지 {count}건 ")
                    span = soup.new_tag("span")
                    span["style"] = "font-size:13px;font-weight:500;color:#4a5670"
                    span.string = f"({share}%)"
                    parts[0].append(span)
                if len(parts) > 1:
                    section = item.get("section") or item.get("label") or "화면"
                    scroll_y = int(item.get("captured_scroll_y") or item.get("scroll_y") or 0)
                    parts[1].string = f"section {section} · scrollY {scroll_y}"
            if len(children) > 1:
                children[1].string = str(item.get("url") or item.get("page_url") or item.get("label") or "-")
        for card in cards[max(len(hotspots), len(fallback)):3]:
            set_style_value(card, "display", "none")
        page = str(soup)

    if source_index in {18, 19}:
        page = page.replace("186", str(profile_total or sessions)).replace("5개 고객 유형", f"{len(profiles)}개 고객 유형")
    if source_index == 18:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        table = soup.find("sc-raw-table")
        if table and profiles:
            rows = table.find_all("sc-raw-tr")[1:]
            likelihoods = purchase_likelihoods(profiles)
            for position, (row, profile) in enumerate(zip(rows, profiles)):
                ai_profile = ai_for_profile(inputs, profile, position)
                cells = row.find_all("sc-raw-td")
                if len(cells) >= 3:
                    marker = cells[0].find("span")
                    cells[0].clear()
                    if marker:
                        cells[0].append(marker)
                    cells[0].append(str(profile.get("name") or "고객 유형"))
                    badge = cells[1].find("span")
                    if badge:
                        badge.string = likelihoods[position]
                    else:
                        cells[1].string = likelihoods[position]
                    cells[2].string = str(ai_profile.get("recommended_action") or profile.get("action") or "행동 패턴에 맞춘 운영 전략을 적용하세요.")
        page = str(soup)
        page = re.sub(r'<h2\b[^>]*>\s*종합 제언\s*</h2>', '', page, count=1)
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        label = next((tag for tag in soup.find_all("span") if tag.get_text(strip=True) == "종합 제언"), None)
        if label and label.parent:
            set_style_value(label.parent, "margin-top", "18px")
            set_style_value(label.parent, "padding", "16px 18px 12px")
            overall = next(iter(label.parent.find_all("div", recursive=False)), None)
            if overall and (inputs.get("ai") or {}).get("overall_recommendation"):
                overall.string = str(inputs["ai"]["overall_recommendation"])
                set_style_value(overall, "font-size", "13px")
                set_style_value(overall, "line-height", "1.6")
        page = str(soup)
    if source_index == 19:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        table = soup.find_all("sc-raw-table")[-1] if soup.find_all("sc-raw-table") else None
        next_metrics = (inputs.get("ai") or {}).get("next_metrics") or []
        if table and next_metrics:
            for row, item in zip(table.find_all("sc-raw-tr")[1:], next_metrics):
                cells = row.find_all("sc-raw-td")
                if len(cells) >= 2:
                    cells[0].string = str(item.get("metric") or "추적 지표")
                    cells[1].string = str(item.get("success_signal") or "현재보다 개선")
                    set_style_value(cells[1], "font-weight", "700")
                    set_style_value(cells[1], "color", "#17407a")
        page = str(soup)
    return page


def _pie_path(start_pct: float, end_pct: float) -> str:
    if end_pct - start_pct >= 99.999:
        return "M50,50 m-49,0 a49,49 0 1,0 98,0 a49,49 0 1,0 -98,0"
    start = math.radians(start_pct * 3.6 - 90)
    end = math.radians(end_pct * 3.6 - 90)
    x1, y1 = 50 + 49 * math.cos(start), 50 + 49 * math.sin(start)
    x2, y2 = 50 + 49 * math.cos(end), 50 + 49 * math.sin(end)
    large = 1 if end_pct - start_pct > 50 else 0
    return f"M50,50 L{x1:.3f},{y1:.3f} A49,49 0 {large},1 {x2:.3f},{y2:.3f} Z"


def replace_conic_charts(page: str) -> str:
    """Replace CSS conic gradients with explicit SVG sectors for PDF stability."""
    pattern = re.compile(
        r'<div style="(?P<style>[^"]*?)background:\s*conic-gradient\((?P<stops>[^)]*)\)(?P<tail>[^"]*)"></div>',
        flags=re.I,
    )

    def convert(match: re.Match[str]) -> str:
        raw_stops = match.group("stops")
        sectors = []
        for color, start, end in re.findall(
            r'(#[0-9a-fA-F]{3,8})\s+([0-9.]+)%\s+([0-9.]+)%', raw_stops
        ):
            sectors.append((color, float(start), float(end)))
        if not sectors:
            return match.group(0)
        style = (match.group("style") + match.group("tail")).strip().rstrip(";")
        paths = "".join(
            f'<path d="{_pie_path(start, end)}" fill="{color}"/>'
            for color, start, end in sectors
        )
        return (
            f'<div style="{style};border-radius:50%;overflow:hidden">'
            f'<svg viewBox="0 0 100 100" width="100%" height="100%" '
            f'xmlns="http://www.w3.org/2000/svg" aria-label="비율 원형 그래프">{paths}</svg></div>'
        )

    return pattern.sub(convert, page)


def insert_capture_images(page: str) -> str:
    capture_dir = ROOT / "ml" / "output" / "reports" / "exit_captures"
    captures = sorted(capture_dir.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    chosen = []
    for index in (1, 2, 3):
        match = next((p for p in captures if p.name.startswith(f"exit_hotspot_{index}_")), None)
        if match:
            chosen.append(match)
    if not chosen:
        return page

    image_iter = iter(chosen)
    placeholder = re.compile(
        r'<div style="(?P<style>[^"]*border:[^;\"]*dashed[^"]*)">\s*캡처 이미지 영역[^<]*</div>',
        flags=re.S,
    )

    def replace(match: re.Match[str]) -> str:
        try:
            path = next(image_iter)
        except StopIteration:
            return match.group(0)
        image_data = base64.b64encode(path.read_bytes()).decode("ascii")
        image_uri = f"data:image/png;base64.{image_data}"
        return (
            f'<div style="{match.group("style")};overflow:hidden">'
            f'<img src="{image_uri}" '
            f'style="width:100%;height:100%;object-fit:cover;object-position:top;display:block"/></div>'
        )

    return placeholder.sub(replace, page)


def cafe24_recommendation(inputs: dict) -> dict:
    metrics = inputs.get("metrics") or {}
    commerce = inputs.get("commerce") or {}
    overview = metrics.get("overview") or {}
    sessions = int(overview.get("sessions") or 0)
    product_sessions = int(overview.get("product_sessions") or 0)
    cart_sessions = int(overview.get("cart_sessions") or 0)
    product_rate = rate(product_sessions, sessions)
    cart_rate = rate(cart_sessions, product_sessions)
    exit_pages = metrics.get("exit_pages") or []
    top_exit = exit_pages[0] if exit_pages else {}
    review_views = int((commerce.get("counts") or {}).get("review_views") or 0)

    if product_sessions >= 10 and cart_rate < 2:
        return {
            "title": "상품 상세 상단에 구매 판단 정보 요약",
            "description": f"상품 조회 {product_sessions}세션 중 장바구니 도달은 {cart_sessions}세션으로, 다음 단계 이동을 돕는 정보가 필요해요.",
            "metric": f"장바구니 진행률 {cart_rate:.1f}%",
            "path": "카페24 관리자 › 디자인 › 디자인 보관함 › 사용 중 디자인 수정 › 상품 상세(detail.html)",
            "before": "배송·교환·사이즈·후기 정보가 흩어져 구매 판단에 시간이 걸릴 수 있어요.",
            "after_title": "구매 전에 확인하세요",
            "after_text": "배송·교환·사이즈·후기 정보를 한곳에서 확인할 수 있어요.",
            "insert": "상품명·가격 영역 아래, 옵션 선택 영역 위에 추가",
            "code": """<div class="seer-decision-guide">
  <strong>구매 전에 확인하세요</strong>
  <p>배송·교환 정책 · 사이즈·착용 정보 · 실구매자 후기</p>
</div>
<style>
.seer-decision-guide { padding:14px 16px; margin:12px 0 18px;
  background:#f3f5f9; color:#1d2a44; }
.seer-decision-guide strong { display:block; margin-bottom:6px; }
.seer-decision-guide p { margin:0; font-size:13px; }
</style>""",
            "check": f"다음 주 상품 조회→장바구니 진행률이 {cart_rate:.1f}%보다 높아지는지 확인해요.",
        }
    if product_rate < 35:
        return {
            "title": "첫 화면에 대표 상품 이동 버튼 강화",
            "description": f"방문 {sessions}세션 중 상품 조회 도달은 {product_sessions}세션({product_rate:.1f}%)이에요.",
            "metric": f"상품 조회 진행률 {product_rate:.1f}%",
            "path": "카페24 관리자 › 디자인 › 디자인 보관함 › 사용 중 디자인 수정 › 메인 화면(index.html)",
            "before": "첫 화면 콘텐츠에서 상품 목록으로 이어지는 다음 행동이 불명확할 수 있어요.",
            "after_title": "이번 주 대표 상품 보기",
            "after_text": "대표 상품 목록으로 바로 이동할 수 있어요.",
            "insert": "메인 배너 바로 아래에 추가",
            "code": """<a class="seer-main-cta" href="/product/list.html?cate_no=1">
  이번 주 대표 상품 보기
</a>
<style>
.seer-main-cta { display:block; padding:14px 18px; margin:16px 0;
  background:#17407a; color:#fff; text-align:center; font-weight:700; }
</style>""",
            "check": f"다음 주 상품 조회 진행률이 {product_rate:.1f}%보다 높아지는지 확인해요.",
        }
    if "카테고리" in str(top_exit.get("label") or ""):
        return {
            "title": "카테고리 상단에 탐색 안내 추가",
            "description": f"가장 많이 이탈한 화면은 {top_exit.get('label')} {top_exit.get('sessions', 0)}세션이에요.",
            "metric": f"이탈 비중 {top_exit.get('share', 0)}%",
            "path": "카페24 관리자 › 디자인 › 디자인 보관함 › 사용 중 디자인 수정 › 상품 분류(list.html)",
            "before": "상품이 많을 때 비교 기준과 다음 탐색 경로를 찾기 어려울 수 있어요.",
            "after_title": "원하는 상품을 빠르게 찾아보세요",
            "after_text": "가격·신상품·인기순 정렬과 카테고리 이동을 안내해요.",
            "insert": "상품 목록과 정렬 메뉴 바로 위에 추가",
            "code": """<div class="seer-category-guide">
  가격·신상품·인기순 정렬로 원하는 상품을 빠르게 찾아보세요.
</div>
<style>
.seer-category-guide { padding:12px 16px; margin-bottom:14px;
  background:#eef2fa; color:#17407a; font-size:13px; }
</style>""",
            "check": "다음 주 카테고리 화면 이탈 비중이 낮아지는지 확인해요.",
        }
    return {
        "title": "상품 상세에 후기 탐색 연결 강화",
        "description": f"이번 주 리뷰 확인은 {review_views}회로, 구매 판단 정보를 더 쉽게 연결할 여지가 있어요.",
        "metric": f"리뷰 확인 {review_views}회",
        "path": "카페24 관리자 › 디자인 › 디자인 보관함 › 사용 중 디자인 수정 › 상품 상세(detail.html)",
        "before": "후기 영역이 상품 정보와 멀리 떨어져 있으면 구매 판단 흐름이 끊길 수 있어요.",
        "after_title": "실구매자 후기를 확인해 보세요",
        "after_text": "상품 정보에서 후기 영역으로 바로 이동할 수 있어요.",
        "insert": "상품 요약 정보 아래에 추가하고 후기 영역 ID를 확인",
        "code": """<a class="seer-review-link" href="#prdReview">
  실구매자 후기 확인하기
</a>
<style>
.seer-review-link { display:block; padding:12px 16px; margin:14px 0;
  border:1px solid #17407a; color:#17407a; text-align:center; }
</style>""",
        "check": "다음 주 후기 확인 후 장바구니 도달률이 높아지는지 확인해요.",
    }


def build_cafe24_appendix(start_dt: datetime, end_dt: datetime, site: str, page_no: int, total_pages: int, inputs: dict) -> str:
    """Load the approved Cafe24 implementation guide as a report appendix."""
    source_path = ROOT / "prototypes" / "weekly-report-cafe24-code-guide.html"
    if not source_path.exists():
        raise FileNotFoundError(f"Cafe24 appendix template was not found: {source_path}")
    source = source_path.read_text(encoding="utf-8")
    style_match = re.search(r"<style>(.*?)</style>", source, flags=re.S | re.I)
    main_match = re.search(r"<main\b[^>]*class=\"page\"[^>]*>.*?</main>", source, flags=re.S | re.I)
    if not style_match or not main_match:
        raise ValueError("Cafe24 appendix template is missing its style or page element")
    style = style_match.group(1)
    style = re.sub(r"@page\s*\{[^}]*\}", "", style, flags=re.S | re.I)
    style = re.sub(r"html\s*,\s*body\s*\{[^}]*\}", "", style, flags=re.S | re.I)
    style = re.sub(
        r"@media\s+print\s*\{\s*html\s*,\s*body\s*\{[^}]*\}\s*\.page\s*\{[^}]*\}\s*\}",
        "", style, flags=re.S | re.I,
    )
    style = style.replace(".page", ".cafe24-appendix")
    style += """
.cafe24-appendix { margin:0 !important; }
.cafe24-appendix, .cafe24-appendix * { font-family:"Noto Sans KR",sans-serif !important; }
.cafe24-appendix h1 { font-size:28px !important; font-weight:900 !important; letter-spacing:-0.7px !important; color:#17407a !important; }
.cafe24-appendix .section-title, .cafe24-appendix .priority-title { font-weight:900 !important; }
.source-page-cafe24 .footer { display:flex !important; justify-content:space-between !important; left:56px !important; right:68px !important; }
.source-page-cafe24 .footer span:last-child { display:block !important; flex:none !important; min-width:56px !important; text-align:right !important; }
"""
    main = main_match.group(0).replace('class="page"', 'class="cafe24-appendix"', 1)
    main = main.replace("Dignolucir", site)
    main = re.sub(r"2026\.10\.23\s*-\s*10\.29", f"{start_dt:%Y.%m.%d} - {end_dt:%m.%d}", main)
    main = re.sub(r"\d+\s*/\s*\d+", f"{page_no} / {total_pages}", main)
    recommendation = cafe24_recommendation(inputs)
    soup = __import__("bs4").BeautifulSoup(main, "html.parser")
    subtitle = soup.select_one(".subtitle")
    if subtitle:
        subtitle.string = "이번 주 실제 행동 지표를 카페24 수정 위치와 코드로 연결했어요."
    priority = soup.select_one(".priority-title")
    if priority:
        priority.clear()
        priority.append(recommendation["title"])
        detail = soup.new_tag("span")
        detail.string = recommendation["description"]
        priority.append(detail)
    impact = soup.select_one(".impact")
    if impact:
        impact.clear()
        impact.append("실제 분석 근거")
        impact.append(soup.new_tag("br"))
        impact.append(recommendation["metric"])
    path = soup.select_one(".path")
    if path:
        path.string = recommendation["path"]
    before = soup.select_one(".before-note")
    if before:
        before.string = recommendation["before"]
    banner = soup.select_one(".benefit-banner")
    if banner:
        banner.clear()
        strong = soup.new_tag("b")
        strong.string = recommendation["after_title"]
        detail = soup.new_tag("span")
        detail.string = recommendation["after_text"]
        banner.extend([strong, detail])
    code_head = soup.select_one(".code-head span")
    if code_head:
        code_head.string = recommendation["insert"]
    code = soup.find("pre")
    if code:
        code.string = recommendation["code"]
    checks = soup.select(".check")
    if len(checks) >= 3:
        checks[0].find("b").string = "1. 모바일 화면"
        checks[0].find("span").string = "안내 영역이 옵션 선택이나 구매 버튼을 가리지 않는지 확인해요."
        checks[1].find("b").string = "2. 정보 정확성"
        checks[1].find("span").string = "배송·교환·사이즈 문구가 실제 쇼핑몰 정책과 일치하는지 확인해요."
        checks[2].find("b").string = "3. 다음 주 지표"
        checks[2].find("span").string = recommendation["check"]
    notice = soup.select_one(".notice")
    if notice:
        notice.clear()
        notice.append("적용 전 확인 · 이번 주 행동 데이터로 자동 선택된 제안입니다. 디자인을 복사해 백업하고 PC·모바일 미리보기 후 게시하세요.")
    main = str(soup)
    return f'<style class="cafe24-appendix-style">{style}</style>{main}'


def build_exact_html(source_path: Path, start: str, end: str, origin: str, inputs: dict | None = None) -> str:
    pages = split_pages(source_path.read_text(encoding="utf-8"))
    if len(pages) < 20:
        extracted = sorted((ROOT / "ml" / "templates" / "weekly_report").glob("design-page-*.html"))
        pages = [split_pages(path.read_text(encoding="utf-8"))[0] for path in extracted]
    if len(pages) < 20:
        raise ValueError(f"Expected 20 design pages, found {len(pages)}")

    # Cover A + every unique body design. Cover alternatives B-E are excluded.
    selected: list[int | str] = [0, *range(5, 19), "cafe24-appendix", 19]
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    date_long = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    date_short = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    week = f"{end_dt.year}년 {end_dt.month}월 {(end_dt.day - 1) // 7 + 1}주차 운영 현황"
    site = display_site(origin)

    rendered: list[str] = []
    for page_no, source_index in enumerate(selected, 1):
        if source_index == "cafe24-appendix":
            appendix = build_cafe24_appendix(start_dt, end_dt, site, page_no, len(selected), inputs or {})
            rendered.append(f'<section class="report-page source-page-cafe24">{appendix}</section>')
            continue
        assert isinstance(source_index, int)
        page = pages[source_index]
        page = bind_weekly_data(page, source_index, inputs or {})
        # Apply identity fields after numeric substitutions so a data value such
        # as a cluster count of 19 cannot accidentally rewrite the date.
        page = page.replace("Dignolucir", site)
        page = page.replace("2026.10.21 – 10.27", date_long)
        page = page.replace("2026.10.21 - 10.27", date_long)
        page = page.replace("2026년 10월 4주차 운영 현황", week)
        page = page.replace("2026.10.21 – 2026.10.27", date_short)
        page = replace_conic_charts(page)
        if source_index == 12:
            page = insert_capture_images(page)
        # Keep the original footer typography while making numbering truthful.
        page = re.sub(r"\d+\s*/\s*\d+", f"{page_no} / {len(selected)}", page)
        rendered.append(f'<section class="report-page source-page-{source_index + 1}">{page}</section>')

    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&amp;display=swap" rel="stylesheet">
<style>
@page {{ size: 794px 1123px; margin: 0; }}
html, body {{ margin:0; padding:0; background:#fff; }}
.report-page {{ width:794px; height:1123px; overflow:hidden; break-after:page; page-break-after:always; }}
.report-page:last-child {{ break-after:auto; page-break-after:auto; }}
x-dc {{ display:block; width:794px; height:1123px; }}
helmet {{ display:none; }}
/* The supplied design uses renderer-specific table tags.  Map them to the
   native CSS table model before Chrome prints the document. */
sc-raw-table {{ display:table !important; width:100% !important; border-collapse:collapse !important; table-layout:fixed; }}
sc-raw-thead {{ display:table-header-group !important; }}
sc-raw-tbody {{ display:table-row-group !important; }}
sc-raw-tr {{ display:table-row !important; }}
sc-raw-th {{ display:table-cell !important; vertical-align:middle; }}
sc-raw-td {{ display:table-cell !important; vertical-align:middle; overflow-wrap:anywhere; }}
sc-raw-tr:nth-child(odd):not(:first-child) sc-raw-td {{ background:#f3f5f9; }}
/* Ratio graphics in the source are conic-gradient divs.  Preserve the
   intended circular chart even where the exported HTML contained radius 0. */
[style*="conic-gradient"] {{ border-radius:50% !important; aspect-ratio:1 / 1; flex:none; }}
/* Keep legend percentages visible and aligned at the right edge. */
[style*="flex-direction: column"] > [style*="align-items: center"] b,
[style*="display: flex"][style*="align-items: center"] > b {{ white-space:nowrap; min-width:30px; text-align:right; }}
.source-page-20 sc-raw-th:first-child,
.source-page-20 sc-raw-td:first-child {{ width:22% !important; }}
.source-page-20 sc-raw-th:nth-child(2),
.source-page-20 sc-raw-td:nth-child(2) {{ width:78% !important; }}
</style></head><body>{''.join(rendered)}</body></html>"""


def chrome_path() -> str:
    cache_root = Path(os.environ.get("SEER_BROWSER_CACHE", "/home/opc/.cache/ghosttracker-browser"))
    cached = list(cache_root.glob("**/chrome")) if cache_root.exists() else []
    candidates = [
        os.environ.get("CHROME_BIN"),
        shutil.which("chrome"), shutil.which("google-chrome"),
        shutil.which("google-chrome-stable"), shutil.which("chromium"),
        shutil.which("chromium-browser"), shutil.which("chrome.exe"),
        shutil.which("msedge"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        *cached,
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise FileNotFoundError("Chrome or Edge was not found")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--start", required=True)
    parser.add_argument("--end", required=True)
    parser.add_argument("--origin", default="https://dignolucir.co.kr")
    parser.add_argument("--result-csv", default="")
    parser.add_argument("--metrics-json", default="")
    parser.add_argument("--commerce-json", default="")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        fallback = ROOT / "ml" / "templates" / "weekly_report" / "design-page-01-cover-a.html"
        source = fallback if fallback.exists() else source
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    html_path = output.with_suffix(".html")
    inputs = load_inputs(args.metrics_json, args.commerce_json, args.result_csv)
    inputs["exit_hotspots"] = load_exit_hotspots(args.start, args.end, args.origin)
    inputs["ai"] = generate_weekly_ai(inputs, args.start, args.end, args.origin)
    html_path.write_text(build_exact_html(source, args.start, args.end, args.origin, inputs), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="seer-exact-", ignore_cleanup_errors=True) as temp_dir:
        temp_dir_path = Path(temp_dir)
        temp_html = temp_dir_path / "report.html"
        temp_pdf = temp_dir_path / "report.pdf"
        profile = temp_dir_path / "chrome-profile"
        shutil.copyfile(html_path, temp_html)
        try:
            browser = chrome_path()
        except FileNotFoundError:
            # Oracle 서버에 브라우저 패키지가 없는 경우에도 HTML/PDF 자동 생성이
            # 멈추지 않도록 기존 리포트 런타임의 WeasyPrint를 사용한다.
            from weasyprint import HTML
            HTML(filename=str(temp_html)).write_pdf(str(temp_pdf))
        else:
            subprocess.run([
                browser, "--headless=new", "--disable-gpu", "--disable-extensions",
                "--disable-dev-shm-usage", "--no-first-run", "--no-sandbox",
                "--allow-file-access-from-files", "--virtual-time-budget=5000",
                f"--user-data-dir={profile}", f"--print-to-pdf={temp_pdf}", temp_html.as_uri(),
            ], check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copyfile(temp_pdf, output)
    print(output)


if __name__ == "__main__":
    main()
