"""Build a weekly report by reusing the supplied design HTML verbatim.

The source pages keep their original 794 x 1123 DOM and inline styles.  Only
the report identity fields are replaced; no project CSS is layered on top.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = Path(r"C:\SW4_2\졸작\[디자인] 주간 리포트.html")


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
    if delta > 0:
        return f"▲ {abs(delta):.1f}%p"
    if delta < 0:
        return f"▼ {abs(delta):.1f}%p"
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
        page = str(soup)

    if source_index == 9 and overview:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        channels = metrics.get("channels") or []
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
        direct_share = pct(int(channels[0].get("sessions") or 0), sessions) if channels else 0
        intro = next((tag for tag in soup.find_all("p") if "직접 방문" in tag.get_text()), None)
        if intro:
            intro.string = f"방문의 {direct_share}%가 직접 방문이고, 이번 주는 주문이 {'있어요.' if overview.get('orders') else '없어요.'}"
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

    detail_baselines = {
        13: (0, 110, 59), 14: (1, 33, 18), 15: (2, 19, 10),
        16: (3, 17, 9), 17: (4, 7, 4),
    }
    if source_index in detail_baselines and profiles:
        position, old_count, old_share = detail_baselines[source_index]
        if position < len(profiles):
            profile = profiles[position]
            soup = __import__("bs4").BeautifulSoup(page, "html.parser")
            title = soup.find("h1")
            subtitle = title.find_next_sibling("p") if title else None
            if subtitle:
                subtitle.string = str(profile.get("action") or profile.get("summary") or "이 유형에 맞춘 운영 조치가 필요해요.")
                set_style_value(subtitle, "margin", "0 0 12px")
            elif title:
                subtitle = soup.new_tag("p")
                subtitle["style"] = "margin:0 0 12px;font-size:15px;color:#4a5670"
                subtitle.string = str(profile.get("action") or profile.get("summary") or "이 유형에 맞춘 운영 조치가 필요해요.")
                title.insert_after(subtitle)
            banner = subtitle.find_next_sibling("div") if subtitle else None
            if banner:
                set_style_value(banner, "margin-top", "0")
            evidence_title = next((tag for tag in soup.find_all("div") if tag.get_text(strip=True) == "이 유형으로 분류한 근거"), None)
            if evidence_title:
                evidence = evidence_title.find_next_sibling("div")
                if evidence:
                    evidence_html = re.sub(r"<br\s*/?>\s*<b>운영 의미</b>.*$", "", str(evidence), flags=re.S)
                    evidence.replace_with(__import__("bs4").BeautifulSoup(evidence_html, "html.parser").find())
            page = str(soup)
            page = re.sub(rf"(?<!\d){old_count}(?!\d)", str(profile["count"]), page)
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
            palettes = [
                ["#332288", "#7064AC", "#9990C4", "#BEB8D9", "#DAD7EA"],
                ["#168477", "#44AA99", "#76C4B8", "#A8DED5", "#D7F0EC"],
                ["#A07800", "#C6A83B", "#DDCC77", "#EADFAD", "#F4EED5"],
                ["#A73E50", "#CC6677", "#D98D99", "#E7B6BE", "#F4DDE1"],
                ["#167AA6", "#4CA8CE", "#88CCEE", "#B1DDF1", "#DCEFF8"],
            ]
            palette = palettes[position]
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
        update_bar_group(soup, "확인한 카테고리", categories)
        page = str(soup)

    if source_index == 12:
        page = page.replace("탐색 중지 집중 화면", "고객이 가장 많이 나간 화면")
        page = page.replace(
            "session_end / tab_exit / inactivity를 page_url + section + scrollY로 묶어 상위 3곳을 골랐어요.",
            "고객의 탐색이 끝난 위치를 화면·영역·스크롤 위치별로 묶어 상위 3곳을 보여드려요.",
        )

    if source_index in {18, 19}:
        page = page.replace("186", str(profile_total or sessions)).replace("5개 고객 유형", f"{len(profiles)}개 고객 유형")
    if source_index == 18:
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        table = soup.find("sc-raw-table")
        if table and profiles:
            rows = table.find_all("sc-raw-tr")[1:]
            for row, profile in zip(rows, profiles):
                cells = row.find_all("sc-raw-td")
                if len(cells) >= 3:
                    marker = cells[0].find("span")
                    cells[0].clear()
                    if marker:
                        cells[0].append(marker)
                    cells[0].append(str(profile.get("name") or "고객 유형"))
                    cells[2].string = str(profile.get("action") or "행동 패턴에 맞춘 운영 전략을 적용하세요.")
        page = str(soup)
        page = re.sub(r'<h2\b[^>]*>\s*종합 제언\s*</h2>', '', page, count=1)
        soup = __import__("bs4").BeautifulSoup(page, "html.parser")
        label = next((tag for tag in soup.find_all("span") if tag.get_text(strip=True) == "종합 제언"), None)
        if label and label.parent:
            set_style_value(label.parent, "margin-top", "30px")
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
        image_uri = path.resolve().as_uri()
        return (
            f'<div style="{match.group("style")};overflow:hidden">'
            f'<img src="{image_uri}" '
            f'style="width:100%;height:100%;object-fit:cover;object-position:top;display:block"/></div>'
        )

    return placeholder.sub(replace, page)


def build_exact_html(source_path: Path, start: str, end: str, origin: str, inputs: dict | None = None) -> str:
    pages = split_pages(source_path.read_text(encoding="utf-8"))
    if len(pages) < 20:
        extracted = sorted((ROOT / "ml" / "templates" / "weekly_report").glob("design-page-*.html"))
        pages = [split_pages(path.read_text(encoding="utf-8"))[0] for path in extracted]
    if len(pages) < 20:
        raise ValueError(f"Expected 20 design pages, found {len(pages)}")

    # Cover A + every unique body design. Cover alternatives B-E are excluded.
    selected = [0, *range(5, 20)]
    start_dt = datetime.strptime(start, "%Y-%m-%d")
    end_dt = datetime.strptime(end, "%Y-%m-%d")
    date_long = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    date_short = f"{start_dt:%Y.%m.%d} – {end_dt:%m.%d}"
    week = f"{end_dt.year}년 {end_dt.month}월 {(end_dt.day - 1) // 7 + 1}주차 운영 현황"
    site = display_site(origin)

    rendered: list[str] = []
    for page_no, source_index in enumerate(selected, 1):
        page = pages[source_index]
        page = page.replace("Dignolucir", site)
        page = page.replace("2026.10.21 – 10.27", date_long)
        page = page.replace("2026.10.21 - 10.27", date_long)
        page = page.replace("2026년 10월 4주차 운영 현황", week)
        page = page.replace("2026.10.21 – 2026.10.27", date_short)
        page = bind_weekly_data(page, source_index, inputs or {})
        page = replace_conic_charts(page)
        if source_index == 12:
            page = insert_capture_images(page)
        # Keep the original footer typography while making numbering truthful.
        page = re.sub(r"\d+\s*/\s*\d+", f"{page_no} / {len(selected)}", page)
        rendered.append(f'<section class="report-page source-page-{source_index + 1}">{page}</section>')

    return f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
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
    candidates = [
        shutil.which("chrome"), shutil.which("chrome.exe"), shutil.which("msedge"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
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
    html_path.write_text(build_exact_html(source, args.start, args.end, args.origin, inputs), encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="seer-exact-", ignore_cleanup_errors=True) as temp_dir:
        temp_dir_path = Path(temp_dir)
        temp_html = temp_dir_path / "report.html"
        temp_pdf = temp_dir_path / "report.pdf"
        profile = temp_dir_path / "chrome-profile"
        shutil.copyfile(html_path, temp_html)
        subprocess.run([
            chrome_path(), "--headless=new", "--disable-gpu", "--disable-extensions",
            "--disable-dev-shm-usage", "--no-first-run", "--no-sandbox",
            "--allow-file-access-from-files", "--virtual-time-budget=5000",
            f"--user-data-dir={profile}", f"--print-to-pdf={temp_pdf}", temp_html.as_uri(),
        ], check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copyfile(temp_pdf, output)
    print(output)


if __name__ == "__main__":
    main()
