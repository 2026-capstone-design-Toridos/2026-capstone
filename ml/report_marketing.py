"""
report_marketing.py — 마케팅 의사결정용 지표 페이지

report_html.py의 고객 유형 분석(행동 패턴)과 별개로, 운영자가 "이번 주에 무엇을
바꿀지"를 정하는 데 쓰는 지표를 3쪽으로 만든다.

  1. 이번 주 성과 요약   — 핵심 숫자 + 전주 대비 + 이번 주 할 일 3가지
  2. 구매 여정           — 단계별 도달·가장 크게 새는 지점·기기별·멈춘 화면과 이유
  3. 유입 채널별 성과    — 어느 채널이 방문만 많고 주문은 없는지
  4. 방문이 몰리는 시간  — 광고·메시지 발송 시점

입력은 metrics JSON 하나다(스키마는 ml/dev/sample_metrics.json 참고).
백엔드가 대시보드(/api/logs)와 같은 세션 집계로 만들어 넘겨야 두 화면의 숫자가
일치한다. 이 모듈은 숫자를 계산하지 않고 받은 값으로 비율·판정·문장만 만든다.
"""
from __future__ import annotations

import html as _html
import json
import math

# 채널·기기 비교에 필요한 최소 세션 수. 이보다 적으면 판정하지 않는다.
MIN_N = 20
# 우연으로 설명될 확률이 이 값보다 작을 때만 '점검 필요/확대 후보'로 판정한다.
P_LIMIT = 0.15
# 이 채널 이름들은 "확대할 수 있는 유입"이 아니라 재방문·직접 입력이다.
DIRECT_NAMES = {'직접 방문', 'direct', 'Direct'}
WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일']

BLUE, GREEN, ORANGE, RED, GRAY = '#4f6bff', '#2e7d32', '#e67e22', '#c62828', '#90a4ae'

# 퍼널 단계별로 "어디를 점검할지" — 원인을 단정하지 않고 점검 대상만 제시한다.
STEP_ACTION = {
    0: '홈 첫 화면에서 대표 상품·혜택으로 바로 이어지는지 점검하세요(배너 문구, 추천 상품 영역).',
    1: '상품 상세의 사이즈 안내·후기·혜택이 스크롤 없이 보이는지 점검하세요.',
    2: '장바구니 화면의 배송비·쿠폰 안내와 결제 버튼 위치를 점검하세요.',
    3: '결제 입력 단계(회원가입 요구, 입력 항목 수, 결제수단)를 점검하세요.',
}


def load_metrics(path: str) -> dict | None:
    """metrics JSON을 읽는다. 없거나 깨졌으면 None — 호출하는 쪽이 페이지를 생략한다."""
    if not path:
        return None
    try:
        with open(path, encoding='utf-8-sig') as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  → metrics JSON을 읽지 못했습니다({exc}) → 마케팅 지표 페이지 생략")
        return None
    return data if isinstance(data, dict) else None


# ── 숫자 도우미 ───────────────────────────────────────────────────────────────
def _rate(num, den) -> float:
    return (num / den * 100.0) if den else 0.0


def _pct(v: float) -> str:
    """10 미만은 소수 한 자리, 이상은 정수."""
    if v >= 10:
        return f"{v:.0f}%"
    return f"{v:.1f}%".replace('.0%', '%')


def _poisson_cdf(k: int, lam: float) -> float:
    """P(X <= k), X ~ Poisson(lam). 작은 표본에서 우연 여부를 가늠하는 데 쓴다."""
    if k < 0:
        return 0.0
    if lam <= 0:
        return 1.0
    term = math.exp(-lam)
    total = term
    for i in range(1, k + 1):
        term *= lam / i
        total += term
    return min(total, 1.0)


def _esc(v) -> str:
    return _html.escape(str(v if v is not None else ''))


def _page(start: str, end: str, title: str, body: str) -> str:
    return f"""
<div class="page">
  <div class="page-header">
    <span class="brand">GHOSTTRACKER</span>
    <span class="page-title">{_esc(title)}</span>
    <span class="period">{_esc(start)} ~ {_esc(end)}</span>
  </div>
  <div class="page-body">
{body}
  </div>
</div>
"""


def _sample_banner(metrics: dict) -> str:
    if not metrics.get('_sample'):
        return ''
    return ('<div style="background:#fff3e0;border:1px solid #ffcc80;color:#e65100;'
            'font-size:8pt;padding:2mm 4mm;border-radius:6px;margin-bottom:4mm;">'
            '샘플 데이터입니다. 개발 확인용이며 실제 쇼핑몰 수치가 아닙니다.</div>')


def _note(text: str) -> str:
    return f'<div style="font-size:7.5pt;color:#90a4ae;margin-top:2mm;line-height:1.6;">{text}</div>'


def _kpi(cls: str, value: str, label: str, sub: str = '', color: str = GRAY) -> str:
    sub_html = f'<div style="font-size:8pt;margin-top:1.4mm;color:{color};">{sub}</div>' if sub else ''
    return (f'<div class="kpi-card {cls}"><div class="card-val" style="font-size:20pt;">{value}</div>'
            f'<div class="card-lbl">{label}</div>{sub_html}</div>')


def _delta(cur, prev, cur_cnt, prev_cnt, fmt_prev, fmt_diff, higher_is_better=True):
    """전주 대비 문구와 색. 건수 차이가 우연 수준(±√건수)이면 중립으로 표시한다."""
    if prev is None:
        return '', GRAY
    if abs(cur_cnt - prev_cnt) <= math.sqrt(max(cur_cnt, prev_cnt, 1)):
        return f'변화 작음 (전주 {fmt_prev(prev)})', GRAY
    diff = cur - prev
    arrow = '▲' if diff > 0 else '▼'
    color = GREEN if (diff > 0) == higher_is_better else RED
    return f'{arrow} {fmt_diff(abs(diff))} (전주 {fmt_prev(prev)})', color


# ── 계산 ──────────────────────────────────────────────────────────────────────
def _funnel_steps(funnel: list) -> list:
    """[{stage, sessions}] → 단계별 비율·손실 계산. 마지막 단계가 주문 완료."""
    steps = []
    first = funnel[0]['sessions'] if funnel else 0
    for i, row in enumerate(funnel):
        cur = int(row.get('sessions') or 0)
        prev = int(funnel[i - 1].get('sessions') or 0) if i else None
        steps.append({
            'stage': row.get('stage', ''),
            'sessions': cur,
            'of_first': _rate(cur, first),
            'step_rate': _rate(cur, prev) if prev is not None else None,
            'lost': (prev - cur) if prev is not None else 0,
        })
    return steps


def _biggest_leak(steps: list):
    """손실 인원이 가장 큰 구간의 인덱스(1부터). 손실이 없으면 None."""
    best = None
    for i in range(1, len(steps)):
        if steps[i]['lost'] > 0 and (best is None or steps[i]['lost'] > steps[best]['lost']):
            best = i
    return best


def _prev_counts(metrics: dict):
    """전주 단계별 인원 [방문, 상품 조회, 장바구니, 결제 시작, 주문 완료]. 하나라도 없으면 None."""
    pv = metrics.get('prev_overview') or {}
    keys = ['sessions', 'product_sessions', 'cart_sessions', 'checkout_sessions', 'orders']
    if any(pv.get(k) is None for k in keys):
        return None
    return [int(pv[k]) for k in keys]


def _worsened_step(steps: list, prev):
    """전주보다 진행률이 눈에 띄게 나빠진 구간(우연 수준을 넘는 것 중 부족 인원이 가장 큰 것)."""
    if not prev or len(prev) != len(steps):
        return None
    best, best_gap = None, 0.0
    for i in range(1, len(steps)):
        base = prev[i - 1]
        if base < MIN_N or prev[i] == 0:
            continue
        prev_rate = prev[i] / base
        expected = steps[i - 1]['sessions'] * prev_rate
        gap = expected - steps[i]['sessions']
        if expected >= 5 and gap > math.sqrt(expected) and gap > best_gap:
            best, best_gap = i, gap
    if best is None:
        return None
    return {'i': best, 'prev_rate': _rate(prev[best], prev[best - 1]), 'gap': best_gap}


def _channel_rows(channels: list, total_sessions: int, total_orders: int) -> list:
    avg = _rate(total_orders, total_sessions)
    rows = []
    for c in channels:
        n = int(c.get('sessions') or 0)
        orders = int(c.get('orders') or 0)
        conv = _rate(orders, n)
        share = _rate(n, total_sessions)
        name = c.get('name', '')
        expected = n * avg / 100.0
        p_low = _poisson_cdf(orders, expected)            # 평균이라면 이만큼 '적을' 확률
        p_high = 1.0 - _poisson_cdf(orders - 1, expected)  # 평균이라면 이만큼 '많을' 확률
        if n < MIN_N:
            tag, color = '표본 적음', GRAY
        elif total_orders == 0:
            tag, color = '주문 없음', GRAY
        elif name in DIRECT_NAMES:
            tag, color = '재방문 중심', BLUE
        elif orders >= 3 and conv > avg and p_high < P_LIMIT:
            tag, color = '확대 후보', GREEN
        elif share >= 10 and expected >= 2 and conv < avg and p_low < P_LIMIT:
            tag, color = '점검 필요', RED
        else:
            tag, color = '유지', BLUE
        rows.append({
            'name': name, 'sessions': n, 'share': share, 'orders': orders,
            'product_rate': _rate(int(c.get('product_sessions') or 0), n),
            'cart_rate': _rate(int(c.get('cart_sessions') or 0), n),
            'conv': conv, 'order_share': _rate(orders, total_orders),
            'expected': expected, 'p_low': p_low, 'p_high': p_high, 'tag': tag, 'color': color,
        })
    return rows


def _peak_window(hourly: list, width: int = 3):
    best_i, best_sum = 0, -1
    for i in range(0, 24 - width + 1):
        s = sum(hourly[i:i + width])
        if s > best_sum:
            best_i, best_sum = i, s
    return best_i, best_sum


def _action_items(metrics: dict, steps: list, leak, worsened, channel_rows: list) -> list:
    """이번 주 할 일. 데이터에서 근거가 나온 것만 만든다."""
    items = []
    if worsened:
        i = worsened['i']
        s, p = steps[i], steps[i - 1]
        items.append({
            'title': f"{p['stage']} → {s['stage']} 진행률이 전주보다 떨어짐",
            'evidence': (f"전주 {_pct(worsened['prev_rate'])}에서 이번 주 {_pct(s['step_rate'])}로 낮아졌습니다. "
                         f"전주 수준이었다면 {s['sessions'] + worsened['gap']:.0f}명이 넘어갔을 구간입니다."),
            'action': STEP_ACTION.get(i - 1, ''),
            'check': f"다음 주 확인: {s['stage']} 진행률 {_pct(s['step_rate'])} → 전주 수준 {_pct(worsened['prev_rate'])} 회복 여부",
        })
    elif leak is not None:
        s, p = steps[leak], steps[leak - 1]
        items.append({
            'title': f"{p['stage']} → {s['stage']} 구간이 가장 많이 멈춤",
            'evidence': (f"{p['stage']} {p['sessions']:,}명 중 {s['sessions']:,}명만 다음 단계로 갔습니다 "
                         f"({_pct(s['step_rate'])}, {s['lost']:,}명 멈춤). 앞 단계일수록 인원이 많아 "
                         f"절대 인원이 커 보일 수 있으니, 전주 자료가 쌓이면 변화로 판단하세요."),
            'action': STEP_ACTION.get(leak - 1, ''),
            'check': f"다음 주 확인: {s['stage']} 진행률 {_pct(s['step_rate'])} → 변화",
        })

    flagged = [r for r in channel_rows if r['tag'] == '점검 필요']
    good = [r for r in channel_rows if r['tag'] == '확대 후보']
    if flagged:
        r = max(flagged, key=lambda x: x['sessions'])
        items.append({
            'title': f"{r['name']} 유입: 방문 대비 주문이 적음",
            'evidence': (f"방문의 {_pct(r['share'])}를 차지하지만 주문은 {r['orders']}건입니다. "
                         f"전체 평균 전환율이면 약 {r['expected']:.1f}건이 기대되며, 평균이라면 이렇게 적을 확률은 약 {_pct(r['p_low'] * 100)}입니다."),
            'action': '이 채널의 랜딩 화면과 광고·게시물 문구가 상품과 맞는지 점검하세요. 개선 전에는 예산 확대를 미루는 것이 안전합니다.',
            'check': f"다음 주 확인: {r['name']} 주문 전환율 {_pct(r['conv'])} → 변화",
        })
    elif good:
        r = max(good, key=lambda x: x['conv'])
        items.append({
            'title': f"{r['name']} 유입 확대 검토",
            'evidence': (f"방문 {r['sessions']:,}명 중 주문 {r['orders']}건(전환율 {_pct(r['conv'])})으로 평균보다 높고, "
                         f"평균이라면 이만큼 많을 확률은 약 {_pct(r['p_high'] * 100)}입니다."),
            'action': '이 채널의 노출·예산을 조금 늘려 같은 전환율이 유지되는지 확인하세요.',
            'check': '다음 주 확인: 방문이 늘어도 전환율이 유지되는지',
        })

    devices = [d for d in (metrics.get('devices') or []) if int(d.get('sessions') or 0) >= MIN_N]
    if len(devices) >= 2:
        rated = sorted(((d, _rate(int(d.get('orders') or 0), int(d['sessions']))) for d in devices),
                       key=lambda x: x[1])
        low, high = rated[0], rated[-1]
        low_n, low_o = int(low[0]['sessions']), int(low[0].get('orders') or 0)
        expected = low_n * high[1] / 100.0
        if high[1] > 0 and int(high[0].get('orders') or 0) >= 3 and _poisson_cdf(low_o, expected) < P_LIMIT and low_o < expected:
            items.append({
                'title': f"{low[0]['name']} 구매 구간 점검",
                'evidence': (f"{low[0]['name']} 주문 전환율은 {_pct(low[1])}로 {high[0]['name']} {_pct(high[1])}보다 낮습니다 "
                             f"(방문 {low_n:,}명 대 {int(high[0]['sessions']):,}명). "
                             f"{high[0]['name']} 수준이라면 약 {expected:.0f}건이 기대됩니다."),
                'action': f"{low[0]['name']} 화면에서 장바구니·결제 버튼 크기, 입력 항목, 결제수단 노출을 직접 구매해 보며 확인하세요.",
                'check': f"다음 주 확인: {low[0]['name']} 전환율 {_pct(low[1])} → 변화",
            })

    hourly = metrics.get('hourly') or []
    if len(items) < 3 and len(hourly) == 24 and sum(hourly) >= 50:
        a, s = _peak_window(hourly)
        items.append({
            'title': f"메시지·광고를 {a}~{a + 3}시 직전에 집행",
            'evidence': f"하루 방문의 {_pct(_rate(s, sum(hourly)))}가 {a}~{a + 3}시에 몰립니다.",
            'action': '쿠폰·푸시·광고 노출을 이 시간대 1~2시간 전에 맞추세요.',
            'check': '다음 주 확인: 같은 시간대 방문·주문 변화',
        })
    return items[:3]


# ── 차트 (HTML/CSS) ───────────────────────────────────────────────────────────
# 인라인 <svg>는 WeasyPrint 52 이하에서 그려지지 않는다(글자만 남는다). 서버 OS의 Pango가
# 낮으면 52.x를 써야 하므로, 막대는 display:table + 퍼센트 너비로 그린다. flex/gap도 쓰지 않는다.
def _cell(width: float, style: str = '') -> str:
    return f'display:table-cell;width:{width:.4f}%;{style}'


def _funnel_html(steps: list, leak) -> str:
    top = max((s['sessions'] for s in steps), default=0) or 1
    rows = []
    for i, s in enumerate(steps):
        if i:
            is_leak = (i == leak)
            lost_txt = f"▼ {_pct(s['step_rate'])} 진행 · {s['lost']:,}명 멈춤"
            color = RED if is_leak else '#78909c'
            weight = 'bold' if is_leak else 'normal'
            rows.append(
                f'<div style="display:table;table-layout:fixed;width:100%;">'
                f'<div style="{_cell(18)}"></div>'
                f'<div style="{_cell(82, f"font-size:8.5pt;line-height:1.7;color:{color};font-weight:{weight};")}">{lost_txt}</div>'
                f'</div>')
        w = max(s['sessions'] / top * 100, 1.2)
        color = ORANGE if (leak is not None and i == leak) else BLUE
        rows.append(
            f'<div style="display:table;table-layout:fixed;width:100%;">'
            f'<div style="{_cell(18, "text-align:right;padding-right:3mm;font-size:9pt;color:#37474f;vertical-align:middle;")}">{_esc(s["stage"])}</div>'
            f'<div style="{_cell(50, "vertical-align:middle;")}">'
            f'<div style="width:{w:.1f}%;height:5.5mm;background:{color};border-radius:1.2mm;"></div></div>'
            f'<div style="{_cell(32, "padding-left:3mm;font-size:9pt;font-weight:bold;color:#162252;vertical-align:middle;")}">'
            f'{s["sessions"]:,}명 <span style="color:#78909c;font-weight:normal;">({_pct(s["of_first"])})</span></div>'
            f'</div>')
    return ''.join(rows)


def _bars_html(values: list, labels: list, highlight: set, height_mm: float = 24.0, bar_pct: float = 62.0) -> str:
    """세로 막대. 값마다 같은 너비의 칸을 만들고 칸 아래쪽에 막대를 붙인다."""
    top = max(values) or 1
    col = 100.0 / len(values)
    bars, lbls = [], []
    for i, v in enumerate(values):
        h = max(v / top * height_mm, 0.4)
        color = ORANGE if i in highlight else '#9fb0ff'
        bars.append(
            f'<div style="{_cell(col, f"vertical-align:bottom;height:{height_mm}mm;")}">'
            f'<div style="width:{bar_pct:.0f}%;height:{h:.2f}mm;margin:0 auto;background:{color};"></div></div>')
        lbls.append(
            f'<div style="{_cell(col, "text-align:center;font-size:7pt;color:#607086;padding-top:0.8mm;line-height:1.3;")}">'
            f'{labels[i] or "&nbsp;"}</div>')
    return (f'<div style="display:table;table-layout:fixed;width:100%;">'
            f'<div style="display:table-row;">{"".join(bars)}</div>'
            f'<div style="display:table-row;">{"".join(lbls)}</div></div>')


def _share_bars_html(rows: list) -> str:
    """채널별 '방문 비중' 대 '주문 비중' 짝막대."""
    top = max([r['share'] for r in rows] + [r['order_share'] for r in rows] + [1])
    out = []
    for r in rows:
        w1 = max(r['share'] / top * 66, 1.0)
        w2 = max(r['order_share'] / top * 66, 1.0)
        out.append(
            f'<div style="display:table;table-layout:fixed;width:100%;margin-bottom:2.2mm;">'
            f'<div style="{_cell(20, "text-align:right;padding-right:3mm;font-size:9pt;color:#37474f;vertical-align:middle;")}">{_esc(r["name"])}</div>'
            f'<div style="{_cell(80, "vertical-align:middle;")}">'
            f'<div style="white-space:nowrap;line-height:1;margin-bottom:0.8mm;">'
            f'<span style="display:inline-block;width:{w1:.1f}%;height:2.6mm;background:#9fb0ff;vertical-align:middle;"></span>'
            f'<span style="font-size:7.5pt;color:#607086;margin-left:1.5mm;vertical-align:middle;">방문 {_pct(r["share"])}</span></div>'
            f'<div style="white-space:nowrap;line-height:1;">'
            f'<span style="display:inline-block;width:{w2:.1f}%;height:2.6mm;background:{GREEN};vertical-align:middle;"></span>'
            f'<span style="font-size:7.5pt;color:{GREEN};margin-left:1.5mm;vertical-align:middle;">주문 {_pct(r["order_share"])}</span></div>'
            f'</div></div>')
    return ''.join(out)


def _tag(text: str, color: str) -> str:
    return (f'<span style="display:inline-block;padding:0.6mm 2.4mm;border-radius:999px;font-size:7.5pt;'
            f'font-weight:bold;color:{color};border:1px solid {color};">{_esc(text)}</span>')


# ── 페이지 ────────────────────────────────────────────────────────────────────
def _time_block(metrics: dict) -> str:
    """방문이 몰리는 시간·요일. 첫 쪽 아래에 들어가는 작은 구역."""
    hourly = metrics.get('hourly') or []
    weekday = metrics.get('weekday') or []
    if len(hourly) != 24 or sum(hourly) == 0:
        return ''
    total = sum(hourly)
    a, s = _peak_window(hourly)
    hour_chart = _bars_html(hourly, [str(h) if h % 3 == 0 else '' for h in range(24)],
                          set(range(a, a + 3)), height_mm=24)
    day_chart, day_line = '', ''
    if len(weekday) == 7 and sum(weekday):
        top = max(range(7), key=lambda i: weekday[i])
        day_line = f" 요일은 <b>{WEEKDAYS[top]}요일</b>({_pct(_rate(weekday[top], sum(weekday)))})이 가장 많습니다."
        day_chart = _bars_html(weekday, WEEKDAYS, {top}, height_mm=24, bar_pct=58)
    small = '' if total >= 50 else ' (방문이 50세션 미만이라 참고용입니다)'
    return f"""
    <div class="section-block">
      <div class="section-title">방문이 몰리는 시간 (한국 시간)</div>
      <div style="display:table;table-layout:fixed;width:100%;">
        <div style="{_cell(70, 'padding-right:6mm;vertical-align:bottom;')}">{hour_chart}</div>
        <div style="{_cell(30, 'vertical-align:bottom;')}">{day_chart}</div>
      </div>
      <div style="font-size:9pt;color:#37474f;line-height:1.8;margin-top:2mm;">
        방문은 <b>{a}~{a + 3}시</b>에 가장 몰립니다(전체의 {_pct(_rate(s, total))}).{day_line}
        쿠폰·푸시·광고는 이 시간 1~2시간 전에 맞춰 시험해 보세요.{small}
      </div>
      {_note('※ 방문이 많은 시간이 주문이 많은 시간과 같다고 단정할 수 없습니다. 다음 주 같은 시간대의 주문 변화로 확인하세요.')}
    </div>"""


def _overview_page(metrics, start, end, steps, leak, worsened, channel_rows) -> str:
    ov = metrics.get('overview') or {}
    pv = metrics.get('prev_overview') or {}
    sessions = int(ov.get('sessions') or 0)
    orders = int(ov.get('orders') or 0)
    carts = int(ov.get('cart_sessions') or 0)
    conv = _rate(orders, sessions)
    cart_rate = _rate(carts, sessions)

    p_sessions = pv.get('sessions') if pv else None
    p_orders = pv.get('orders') if pv else None
    p_carts = pv.get('cart_sessions') if pv else None
    p_conv = _rate(p_orders, p_sessions) if p_sessions and p_orders is not None else None
    p_cart = _rate(p_carts, p_sessions) if p_sessions and p_carts is not None else None

    cnt = lambda v: f'{v:,.0f}'
    won = lambda v: f'{v:,.0f}건'
    rate_prev = lambda v: _pct(v)
    rate_diff = lambda v: f'{v:.1f}%p'
    d_s = _delta(sessions, p_sessions, sessions, p_sessions or 0, cnt, cnt) if p_sessions is not None else ('', GRAY)
    d_o = _delta(orders, p_orders, orders, p_orders or 0, won, won) if p_orders is not None else ('', GRAY)
    d_c = _delta(conv, p_conv, orders, p_orders or 0, rate_prev, rate_diff) if p_conv is not None else ('', GRAY)
    d_k = _delta(cart_rate, p_cart, carts, p_carts or 0, rate_prev, rate_diff) if p_cart is not None else ('', GRAY)
    cards = ''.join([
        _kpi('blue', f'{sessions:,}', '방문 세션', *d_s),
        _kpi('green', f'{orders:,}건', '주문 완료', *d_o),
        _kpi('orange', _pct(conv), '주문 전환율', *d_c),
        _kpi('blue', _pct(cart_rate), '장바구니 도달률', *d_k),
    ])

    items = _action_items(metrics, steps, leak, worsened, channel_rows)
    blocks = []
    for i, it in enumerate(items, 1):
        blocks.append(f"""
    <div style="break-inside:avoid;border:1px solid #dde7f2;border-left:4px solid {BLUE};border-radius:8px;
                padding:3.4mm 5mm;margin-bottom:3.4mm;background:#fff;">
      <div style="font-size:10.5pt;font-weight:bold;color:#162252;">{i}. {_esc(it['title'])}</div>
      <div style="font-size:9pt;color:#37474f;line-height:1.7;margin-top:1.2mm;"><b>근거</b> {_esc(it['evidence'])}</div>
      <div style="font-size:9pt;color:#37474f;line-height:1.7;"><b>할 일</b> {_esc(it['action'])}</div>
      <div style="font-size:8pt;color:#90a4ae;margin-top:0.8mm;">{_esc(it['check'])}</div>
    </div>""")
    todo = ''.join(blocks) or '<div style="font-size:9pt;color:#78909c;">이번 주는 근거가 충분한 개선 항목이 없습니다. 표본이 쌓이면 표시됩니다.</div>'

    body = f"""
    {_sample_banner(metrics)}
    <div class="summary-kpi-row" style="margin-bottom:5mm;">{cards}</div>
    <div class="section-block">
      <div class="section-title">이번 주 할 일</div>
      {todo}
      {_note('※ 주문 완료는 대시보드와 같은 기준(주문 완료 화면 도달 또는 비회원 구매 이벤트)의 세션 수입니다. '
             '전주와의 차이가 우연 수준(건수의 제곱근 이내)이면 "변화 작음"으로 표시합니다. '
             '원인은 데이터만으로 확정할 수 없으므로 "점검 대상"으로 읽어주세요.')}
    </div>
    {_time_block(metrics)}"""
    return _page(start, end, '이번 주 성과 요약', body)


def _journey_page(metrics, start, end, steps, leak, worsened) -> str:
    chart = _funnel_html(steps, leak)
    lines = []
    if leak is not None:
        s, p = steps[leak], steps[leak - 1]
        lines.append(f"<b>가장 많이 멈춘 구간</b>: {_esc(p['stage'])} → {_esc(s['stage'])} "
                     f"({s['lost']:,}명, 진행률 {_pct(s['step_rate'])}). 앞 단계일수록 인원이 많아 절대 인원이 크게 나옵니다.")
    if worsened:
        i = worsened['i']
        s, p = steps[i], steps[i - 1]
        lines.append(f"<b>전주보다 나빠진 구간</b>: {_esc(p['stage'])} → {_esc(s['stage'])} "
                     f"({_pct(worsened['prev_rate'])} → {_pct(s['step_rate'])}). {_esc(STEP_ACTION.get(i - 1, ''))}")
    elif leak is not None:
        lines.append(f"<b>점검 대상</b>: {_esc(STEP_ACTION.get(leak - 1, ''))}")
    if not lines:
        lines.append('단계 사이에서 두드러지게 멈추는 구간이 없습니다.')
    diag = '<br>'.join(lines)

    dev_html = ''
    devices = metrics.get('devices') or []
    if devices:
        rows = []
        for d in devices:
            n = int(d.get('sessions') or 0)
            carts, orders = int(d.get('cart_sessions') or 0), int(d.get('orders') or 0)
            if n < MIN_N:
                cells = ("<td style='text-align:center;color:#90a4ae;'>–</td>" * 2
                         + f"<td style='text-align:center;color:#90a4ae;'>{orders}건 (표본 적음)</td>")
            else:
                cells = (f"<td style='text-align:center;'>{_pct(_rate(carts, n))}</td>"
                         f"<td style='text-align:center;font-weight:bold;color:#1a237e;'>{_pct(_rate(orders, n))}</td>"
                         f"<td style='text-align:center;'>{orders}건</td>")
            rows.append(f"<tr><td>{_esc(d.get('name'))}</td><td style='text-align:center;'>{n:,}</td>{cells}</tr>")
        dev_html = f"""
    <div class="section-block">
      <div class="section-title">기기별 비교</div>
      <table class="rec-table">
        <tr><th>기기</th><th style="text-align:center;">방문 세션</th><th style="text-align:center;">장바구니 도달률</th>
            <th style="text-align:center;">주문 전환율</th><th style="text-align:center;">주문</th></tr>
        {''.join(rows)}
      </table>
    </div>"""

    def mini(title, rows):
        if not rows:
            return ''
        trs = ''.join(f"<tr><td>{_esc(r.get('label'))}</td><td style='text-align:center;'>{int(r.get('sessions') or 0):,}</td>"
                      f"<td style='text-align:center;'>{_pct(float(r.get('share') or 0))}</td></tr>" for r in rows[:3])
        return (f'<div><div class="section-title" style="font-size:10pt;">{title}</div>'
                f'<table class="rec-table"><tr><th>구분</th><th style="text-align:center;">세션</th>'
                f'<th style="text-align:center;">비중</th></tr>{trs}</table></div>')

    stop = mini('고객이 마지막에 머문 화면', metrics.get('exit_pages'))
    why = mini('멈춘 흔적(추정)', metrics.get('exit_causes'))
    stop_html = (f'<div class="section-block"><div style="display:table;table-layout:fixed;width:100%;">'
                 f'<div style="{_cell(50, "padding-right:3mm;vertical-align:top;")}">{stop}</div>'
                 f'<div style="{_cell(50, "padding-left:3mm;vertical-align:top;")}">{why}</div>'
                 f'</div>{_note("※ 탐색 중지 세션(주문 없이 창을 닫거나 오래 멈춘 세션) 기준 비중입니다.")}</div>') if (stop or why) else ''

    body = f"""
    {_sample_banner(metrics)}
    <div class="section-block">
      <div class="section-title">단계별 고객 수</div>
      <div style="padding:0 2mm;">{chart}</div>
      {_note('※ 각 단계는 그 화면 또는 그 이후 화면에 도달한 세션 수입니다(주문을 완료한 세션은 앞 단계를 모두 거친 것으로 셉니다). 주황색 막대는 가장 많이 멈춘 구간을 지나 도착한 단계입니다.')}
    </div>
    <div class="section-block">
      <div class="insight-box"><div class="insight-label">읽는 법</div>{diag}</div>
    </div>
    {dev_html}
    {stop_html}"""
    return _page(start, end, '구매 여정', body)


def _channel_page(metrics, start, end, rows, total_orders) -> str:
    if not rows:
        return ''
    trs = []
    for r in rows:
        trs.append(
            f"<tr><td style='font-weight:bold;'>{_esc(r['name'])}</td>"
            f"<td style='text-align:center;'>{r['sessions']:,} <span style='color:#90a4ae;font-size:7.5pt;'>({_pct(r['share'])})</span></td>"
            f"<td style='text-align:center;'>{_pct(r['product_rate'])}</td>"
            f"<td style='text-align:center;'>{_pct(r['cart_rate'])}</td>"
            f"<td style='text-align:center;font-weight:bold;color:#1a237e;'>{_pct(r['conv'])} "
            f"<span style='color:#90a4ae;font-size:7.5pt;font-weight:normal;'>({r['orders']}건)</span></td>"
            f"<td style='text-align:center;'>{_tag(r['tag'], r['color'])}</td></tr>")

    notes = []
    for r in rows:
        if r['tag'] == '점검 필요':
            notes.append(f"<li><b>{_esc(r['name'])}</b>: 방문 {r['sessions']:,}명(전체의 {_pct(r['share'])})인데 주문 {r['orders']}건. "
                         f"평균 전환율이면 약 {r['expected']:.1f}건이 기대되고, 평균이라면 이렇게 적을 확률은 약 {_pct(r['p_low'] * 100)}입니다.</li>")
        elif r['tag'] == '확대 후보':
            notes.append(f"<li><b>{_esc(r['name'])}</b>: 주문 {r['orders']}건, 평균이라면 이만큼 많을 확률은 약 {_pct(r['p_high'] * 100)}입니다.</li>")
    if total_orders == 0:
        notes.append("<li>이번 기간에는 주문이 없어 채널 간 주문 전환율을 비교할 수 없습니다. "
                     "상품 조회율과 장바구니율로 채널을 먼저 비교하고, 주문이 쌓인 뒤 판단하세요.</li>")
    elif total_orders < 10:
        notes.append(f"<li>이번 기간 주문이 {total_orders}건뿐이라 채널 간 전환율 차이는 우연일 수 있습니다. "
                     f"방문·장바구니 도달률과 함께 보고, 주문이 쌓인 뒤 판단하세요.</li>")
    reading = (f'<div class="insight-box" style="margin-top:3mm;"><div class="insight-label">읽을 때 참고</div>'
               f'<ul style="margin:0;padding-left:5mm;line-height:1.8;">{"".join(notes)}</ul></div>') if notes else ''

    body = f"""
    {_sample_banner(metrics)}
    <div class="section-block">
      <div class="section-title">유입 채널별 성과</div>
      <table class="rec-table">
        <tr><th>채널</th><th style="text-align:center;">방문 세션</th><th style="text-align:center;">상품 조회율</th>
            <th style="text-align:center;">장바구니율</th><th style="text-align:center;">주문 전환율</th>
            <th style="text-align:center;">판단</th></tr>
        {''.join(trs)}
      </table>
      {_note(f'※ 채널은 세션 최초 유입 기준이고, 방문 {MIN_N}세션 이상인 채널만 판단합니다. '
             f'"점검 필요"는 방문 비중 10% 이상이면서 평균 전환율이라면 이렇게 적게 나올 확률이 {_pct(P_LIMIT * 100)} 미만일 때, '
             f'"확대 후보"는 주문 3건 이상이면서 이렇게 많이 나올 확률이 {_pct(P_LIMIT * 100)} 미만일 때입니다.')}
    </div>
    <div class="section-block">
      <div class="section-title">방문 비중 대 주문 비중</div>
      <div style="padding:0 2mm;">{_share_bars_html(rows)}</div>
      {_note('※ 파란 막대(방문)보다 초록 막대(주문)가 짧을수록 방문은 많은데 주문으로 이어지지 않는 채널입니다.')}
    </div>
    {reading}"""
    return _page(start, end, '유입 채널 성과', body)


def build_marketing_pages(metrics: dict, start: str, end: str) -> str:
    """metrics JSON → 마케팅 지표 페이지 HTML. 핵심 값이 없으면 빈 문자열."""
    ov = (metrics or {}).get('overview') or {}
    funnel = (metrics or {}).get('funnel') or []
    if not int(ov.get('sessions') or 0) or not funnel:
        return ''
    steps = _funnel_steps(funnel)
    leak = _biggest_leak(steps)
    worsened = _worsened_step(steps, _prev_counts(metrics))
    total_sessions = int(ov.get('sessions') or 0)
    total_orders = int(ov.get('orders') or 0)
    rows = _channel_rows(metrics.get('channels') or [], total_sessions, total_orders)
    pages = [
        _overview_page(metrics, start, end, steps, leak, worsened, rows),
        _journey_page(metrics, start, end, steps, leak, worsened),
        _channel_page(metrics, start, end, rows, total_orders),
    ]
    return ''.join(p for p in pages if p)
