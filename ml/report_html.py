"""
report_html.py
--------------
SEER B2B 고객 행동 분석 리포트 (HTML → PDF)

사용법:
  python report_html.py
  python report_html.py --start 2026-05-01 --end 2026-05-27
  python report_html.py --output my_report.pdf
"""

import argparse, base64, html as html_lib, json, os, time, urllib.request, urllib.error
import csv, hashlib, re, shutil, socket, struct, subprocess, tempfile
from datetime import datetime
from io import BytesIO
from urllib.parse import urlparse, urlunparse

os.environ.setdefault('MPLCONFIGDIR', os.path.join(tempfile.gettempdir(), 'ghosttracker-matplotlib'))
os.makedirs(os.environ['MPLCONFIGDIR'], exist_ok=True)

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
import numpy as np

from exit_capture import browser_executable, capture_exit_hotspots
from report_marketing import build_marketing_pages, load_metrics

# ── 경로 ───────────────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
META_PATH  = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_meta.json')
# 퍼널 계산용 세션 단위 데이터 (없으면 퍼널 페이지 자동 생략)
SESSION_SEQ_PATH   = os.path.join(BASE_DIR, 'output/real_sessions_mongodb.csv')
CLUSTER_RESULT_PATH= os.path.join(BASE_DIR, 'output/unsupervised_semantic/semantic_cluster_results.csv')
FONT_DIR   = '/tmp/fonts'
OUT_DIR    = os.path.join(BASE_DIR, 'output/reports')
GEMINI_KEY = os.environ.get('GEMINI_API_KEY', '')
GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
EXIT_CAPTURE_DIR = os.path.join(OUT_DIR, 'exit_captures')

# ── 색상 ───────────────────────────────────────────────────────────────────────
PALETTE = [
    '#39248D','#6F64B3','#9C94CE','#D8D3EC','#1F4B87',
    '#4E78B7','#9CB2DF','#E88924','#F2A14B','#B54B2A',
    '#557F75','#D1BD5C',
]
INTENT_COLOR = {'높음': '#2e7d32', '중간': '#e65100', '낮음': '#b71c1c'}
INTENT_BG    = {'높음': '#e8f5e9', '중간': '#fff3e0', '낮음': '#ffebee'}

# ── 용어 한국어 매핑 ───────────────────────────────────────────────────────────
ACTION_KO = {
    'SCROLL_PRICE' : '가격 훑어보기',
    'START_SESSION': '방문 시작',
    'TAB_OUT'      : '다른 창으로 탐색 중지',
    'CHECK_PRICE'  : '가격 비교',
    'ADD_CART'     : '장바구니 담기',
    'CLICK_BUY'    : '구매하기 클릭',
    'VIEW_PRODUCT' : '상품 상세 확인',
    'VIEW_IMAGE'   : '이미지 크게 보기',
    'VIEW_OPTION'  : '옵션 확인',
    'VIEW_REVIEW'  : '구매 후기 확인',
    'SCROLL'       : '페이지 스크롤',
    'CLICK'        : '항목 클릭',
    'VIEW'         : '상품 조회',
    'LIKE'         : '찜하기',
    'SEARCH'       : '검색',
    'FILTER'       : '필터 적용',
    'BACK'         : '이전으로 이동',
    'EXIT_BOUNCE'  : '즉시 탐색 중지',
    'INACTIVE'     : '장시간 머묾(비활성)',
    'NAVIGATE'     : '페이지 이동',
    'CART_VIEW'    : '장바구니 확인',
    # ── 추가 매핑 (영어 노출 방지) ──
    'SCROLL_HOME'          : '홈 화면 둘러보기',
    'SCROLL_PRODUCT'       : '상품 페이지 둘러보기',
    'SCROLL_PRODUCT_DETAIL': '상품 상세 정독',
    'SCROLL_REVIEW'        : '후기 꼼꼼히 읽기',
    'SCROLL_PRICE'         : '가격 훑어보기',
    'SCROLL_SIZE'          : '사이즈 정보 확인',
    'SCROLL_PAGE'          : '페이지 스크롤',
    'HOVER_ELEMENT'        : '항목에 마우스 올림',
    'CLICK_ELEMENT'        : '항목 클릭',
    'ZOOM_IMAGE'           : '이미지 확대',
    'WATCH_VIDEO'          : '상품 영상 시청',
    'ENTER_HOME'           : '홈 화면 진입',
    'ENTER_PRODUCT'        : '상품 페이지 진입',
    'ENTER_CART'           : '장바구니 진입',
    'ENTER_CATEGORY'       : '카테고리 진입',
    'CHECK_SIZE'           : '사이즈 확인',
    'CHECK_SHIPPING'       : '배송 정보 확인',
    'CHECK_PRICE'          : '가격 확인',
    'CHANGE_OPTION'        : '옵션 변경',
    'CHANGE_QUANTITY'      : '수량 변경',
    'REMOVE_CART'          : '장바구니에서 제거',
    'SEARCH_USE'           : '검색 사용',
    'START_INPUT'          : '입력 시작',
    'TAB_RETURN'           : '다시 돌아옴',
    'RAGE_CLICK'           : '반복 클릭(짜증 신호)',
    'DISTRACTED_EPISODE'   : '주의 분산',
    'EXIT_SESSION'         : '방문 종료',
    'EXIT_BOUNCE'          : '즉시 탐색 중지',
}

# 고객 특성과 무관한 일반 인터랙션 (대표 행동에서 제외)
GENERIC_ACTIONS = {
    'HOVER_ELEMENT', 'CLICK_ELEMENT', 'SCROLL_PAGE', 'SCROLL_HOME',
    'SCROLL_PRODUCT', 'SCROLL', 'NAVIGATE', 'START_SESSION',
    'ENTER_HOME', 'ENTER_PRODUCT', 'START_INPUT', 'TAB_RETURN',
}
PAGE_KO = {
    'HOME'    : '홈 화면',
    'PRODUCT' : '상품 상세',
    'CART'    : '장바구니',
    'CHECKOUT': '결제 페이지',
    'SEARCH'  : '검색 결과',
    'CATEGORY': '카테고리',
    'WISHLIST': '찜 목록',
    'MYPAGE'  : '마이페이지',
}

# 영어 action 코드를 한국어 표현으로 변환한다 — 매핑 없으면 Title Case로 폴백
def ko_action(raw: str) -> str:
    return ACTION_KO.get(raw, raw.replace('_', ' ').title())

# 영어 page 코드를 한국어 표현으로 변환한다
def ko_page(raw: str) -> str:
    return PAGE_KO.get(raw, raw)

# ── 대표 행동 추출 (generic 제외) ──────────────────────────────────────────────
def meaningful_actions(profile: dict, n: int = 7) -> list:
    """고객 특성을 드러내는 행동만 추려 반환. 부족하면 generic으로 보충."""
    acts = profile.get('top_actions', [])
    sig  = [a for a in acts if a['action'] not in GENERIC_ACTIONS]
    if len(sig) < n:
        sig += [a for a in acts if a['action'] in GENERIC_ACTIONS]
    return sig[:n]

# ── 12개 클러스터 → 이름 기준 통합 ─────────────────────────────────────────────
def merge_profiles(raw: dict) -> dict:
    """같은 유형 이름으로 묶어 사장님이 이해할 수 있는 소수 유형으로 통합.
    반환 키는 '0','1',... (방문수 많은 순) — 기존 int 캐스팅 로직과 호환."""
    from collections import Counter
    groups = {}
    for cid, p in raw.items():
        nm = type_name(cid, p)
        g = groups.setdefault(nm, {'name': nm, 'count': 0,
                                   '_acts': Counter(), '_pages': Counter(),
                                   'members': []})
        g['count'] += p.get('count', 0)
        for a in p.get('top_actions', []):
            g['_acts'][a['action']] += a['count']
        for k, v in p.get('page_dist', {}).items():
            g['_pages'][k] += v
        g['members'].append(cid)

    ordered = sorted(groups.values(), key=lambda x: -x['count'])
    out = {}
    for i, g in enumerate(ordered):
        out[str(i)] = {
            'name': g['name'],
            'count': g['count'],
            'top_actions': [{'action': a, 'count': c} for a, c in g['_acts'].most_common()],
            'page_dist': dict(g['_pages']),
            'members': g['members'],
        }
    return out


def load_result_csv(csv_path: str) -> dict:
    """백엔드가 사이트별 행동을 집계한 result.csv를 리포트 프로파일로 변환한다."""
    profiles = {}
    with open(csv_path, encoding='utf-8-sig', newline='') as stream:
        for index, row in enumerate(csv.DictReader(stream)):
            cid = str(row.get('cluster_id') or index)
            try:
                top_actions = json.loads(row.get('top_actions_json') or '[]')
                page_dist = json.loads(row.get('page_dist_json') or '{}')
            except json.JSONDecodeError as exc:
                raise ValueError(f'result.csv JSON 형식 오류 (cluster {cid}): {exc}') from exc
            profiles[cid] = {
                'name': str(row.get('name') or f'고객 유형 {cid}').strip(),
                'count': int(float(row.get('count') or 0)),
                'summary': str(row.get('summary') or '').strip(),
                'action': str(row.get('action') or '').strip(),
                'top_actions': top_actions,
                'page_dist': page_dist,
                'members': [cid],
            }
    if not profiles:
        raise ValueError('result.csv에 고객 유형 데이터가 없습니다.')
    return profiles


def load_commerce_json(json_path: str) -> dict:
    if not json_path or not os.path.exists(json_path):
        return {}
    with open(json_path, encoding='utf-8') as f:
        value = json.load(f)
    return value if isinstance(value, dict) else {}

# ── 데이터 기반 인사이트 템플릿 (유형마다 다르게, Gemini 미사용/실패 시) ──────────
# 유형명에 따라 데이터 기반 인사이트 문단을 반환한다 — Gemini 실패 시 폴백으로 사용
def template_insight(name: str, profile: dict, intent: str, share_pct: int) -> str:
    acts = meaningful_actions(profile, 3)
    top_txt = ', '.join(ko_action(a['action']) for a in acts) or '여러 탐색 행동'
    base = {
        '구매 결정형': (
            f"전체 방문의 {share_pct}%를 차지하며, 장바구니 담기·구매 클릭 같은 "
            f"구매 직전 행동({top_txt})이 뚜렷합니다. 이미 살 마음이 큰 고객이라 "
            f"전환 가능성이 가장 높습니다. 결제 단계를 간소화하고 무료배송·즉시 쿠폰으로 "
            f"마지막 망설임만 없애주면 매출로 바로 이어집니다."),
        '가격 비교형': (
            f"전체 방문의 {share_pct}%로, 가격을 반복해서 확인하는 행동({top_txt})이 핵심입니다. "
            f"살 의향은 있으나 '더 싼 곳이 있을까' 고민하는 단계입니다. "
            f"최저가 보장·적립금·기간 한정 할인 문구를 가격 옆에 노출하면 탐색 중지을 막고 "
            f"구매로 끌어올 수 있습니다."),
        '신중 탐색형': (
            f"전체 방문의 {share_pct}%이며, 후기·사이즈·상세 정보를 꼼꼼히 확인({top_txt})합니다. "
            f"실패 없는 구매를 원하는 고객이라 정보가 충분하면 전환됩니다. "
            f"리뷰 수를 늘리고 사이즈 가이드·실착 사진을 강화하면 구매 결정을 앞당길 수 있습니다."),
        '탐색 중지 위험형': (
            f"전체 방문의 {share_pct}%로, 금방 다른 창으로 빠지거나 탐색 중지하는 신호({top_txt})가 큽니다. "
            f"현재 전환 가능성은 낮지만 재방문 유도로 회복할 수 있습니다. "
            f"장바구니 복귀 쿠폰·재방문 알림을 보내고, 페이지 로딩 속도와 첫 화면 매력도를 점검하세요."),
        '상품 집중형': (
            f"전체 방문의 {share_pct}%이며, 특정 상품을 깊게 들여다보는 행동({top_txt})이 두드러집니다. "
            f"관심 상품은 명확하나 결정까지 시간이 걸립니다. "
            f"함께 구매한 상품·코디 추천을 노출해 결정을 도우면 객단가까지 올릴 수 있습니다."),
        '비주얼 탐색형': (
            f"전체 방문의 {share_pct}%로, 이미지 확대·영상 시청({top_txt}) 등 시각 정보 중심으로 탐색합니다. "
            f"감각적으로 끌리는 상품을 찾는 단계입니다. "
            f"고화질 이미지·360도 뷰·스타일링 콘텐츠를 강화하면 체류와 구매가 함께 늘어납니다."),
        '홈 체류형': (
            f"전체 방문의 {share_pct}%이며, 홈 화면 위주로 머물고({top_txt}) 상품 깊이 탐색은 적습니다. "
            f"아직 무엇을 살지 정하지 못한 초기 방문객입니다. "
            f"기획전 배너·관심 카테고리 맞춤 노출로 상품 페이지로 끌어들이는 게 우선입니다."),
        '일반 탐색형': (
            f"전체 방문의 {share_pct}%로, 뚜렷한 구매 신호 없이 폭넓게 둘러봅니다({top_txt}). "
            f"브랜드를 처음 접하는 단계일 가능성이 큽니다. "
            f"회원가입·첫 구매 혜택으로 관계를 맺어두면 다음 방문에서 전환을 기대할 수 있습니다."),
    }
    return base.get(name,
        f"전체 방문의 {share_pct}%를 차지하는 고객으로, 주로 {top_txt} 행동을 보입니다. "
        f"구매 가능성은 {intent} 수준이며, 해당 행동에 맞춘 안내·혜택을 제공하면 전환을 높일 수 있습니다.")

# ── 폰트 설정 ──────────────────────────────────────────────────────────────────
# NanumGothic 폰트를 /tmp/fonts에 다운로드하고 matplotlib에 등록한다
def setup_fonts():
    os.makedirs(FONT_DIR, exist_ok=True)
    reg  = os.path.join(FONT_DIR, 'NanumGothic-Regular.ttf')
    bold = os.path.join(FONT_DIR, 'NanumGothic-Bold.ttf')
    if not os.path.exists(reg):
        print("폰트 다운로드 중...")
        for url, path in [
            ('https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Regular.ttf', reg),
            ('https://github.com/google/fonts/raw/main/ofl/nanumgothic/NanumGothic-Bold.ttf',    bold),
        ]:
            urllib.request.urlretrieve(url, path)
    fm.fontManager.addfont(reg)
    fm.fontManager.addfont(bold)
    plt.rcParams['font.family']         = 'NanumGothic'
    plt.rcParams['axes.unicode_minus']  = False
    return reg, bold

# ── Gemini AI ─────────────────────────────────────────────────────────────────
DUMMY_INSIGHT = (
    "이 고객 그룹은 주로 상품 페이지와 홈 화면을 오가며 여러 제품을 꼼꼼히 비교하는 패턴을 보입니다. "
    "장바구니 담기나 구매 클릭 비율이 낮아 현재 구매 가능성은 중간 수준으로 판단되며, "
    "적절한 자극이 주어지면 전환 가능성이 높습니다. "
    "이 고객에게는 탐색 중인 상품에 대한 개인화 추천이나 한정 혜택 메시지를 노출하면 "
    "구매 전환율을 효과적으로 높일 수 있습니다."
)

# Gemini API를 호출해 인사이트 텍스트를 받아온다 — 실패 시 DUMMY_INSIGHT 반환
def call_gemini(prompt: str) -> str:
    if not GEMINI_KEY:
        return DUMMY_INSIGHT
    body = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {'temperature': 0.7, 'maxOutputTokens': 8192},
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{GEMINI_URL}?key={GEMINI_KEY}', data=body,
        headers={'Content-Type': 'application/json'}, method='POST',
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                parts = data['candidates'][0]['content']['parts']
                return ''.join(p.get('text','') for p in parts if not p.get('thought')) or DUMMY_INSIGHT
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < 2:
                time.sleep((attempt + 1) * 6)
            else:
                return f'(API 오류 {e.code})'
        except Exception as ex:
            return f'(오류: {ex})'
    return DUMMY_INSIGHT

# 클러스터 프로파일을 바탕으로 Gemini에게 보낼 분석 프롬프트를 만든다
def build_gemini_prompt(cid: str, profile: dict) -> str:
    top  = ', '.join(f"{ko_action(a['action'])}({a['count']}회)"
                     for a in meaningful_actions(profile, 7))
    pages = ', '.join(f"{ko_page(k)}:{v}회"
                      for k, v in sorted(profile.get('page_dist', {}).items(),
                                         key=lambda x: -x[1])[:5])
    nm   = profile.get('name', type_name(cid, profile))
    intt = infer_intent(profile)
    count = int(profile.get('count', 0) or 0)
    return f"""당신은 이커머스 고객 행동 데이터 분석가입니다. 아래 관측값만 근거로 쇼핑몰 운영자가 다음 주에 실행할 수 있는 인사이트를 작성하세요.
아래는 '{nm}' 고객 유형의 방문 행동 데이터입니다.

[이번 달 데이터]
- 유형 이름: {nm}
- 해당 유형 방문 건수: {count}건
- 구매 가능성 등급: {intt}
- 특성 행동 (많이 한 순서): {top}
- 주로 머문 페이지: {pages}

작성 규칙:
- 5문장, 번호·제목·마크다운 없이 하나의 자연스러운 단락으로 작성합니다.
- 1문장: 대표 행동과 주요 페이지를 수치와 함께 요약합니다.
- 2문장: 관측된 행동 흐름을 해석하되 원인·감정·인구통계는 단정하지 않습니다.
- 3문장: 구매 가능성 등급의 근거를 데이터에 연결합니다.
- 4문장: 운영자가 바꿀 화면·메시지·혜택을 구체적으로 1개 제안합니다.
- 5문장: 다음 주에 확인할 행동 지표와 기대 방향을 제시합니다. 데이터에 없는 목표 수치는 만들지 않습니다.
- 'AI', '클러스터', '세그먼트', '유저' 같은 기술 용어와 과장 표현을 쓰지 않습니다.
- 입력에 없는 상품명, 채널, 전환율, 매출, 고객 특성은 추측하지 않습니다."""


def build_overall_prompt(profiles: dict, total_visits: int, funnel: dict | None,
                         commerce: dict) -> str:
    types = []
    for cid in sorted(profiles.keys(), key=int):
        p = profiles[cid]
        share = round((p.get('count', 0) or 0) / max(total_visits, 1) * 100)
        types.append(f"- {p.get('name', type_name(cid, p))}: {p.get('count', 0)}건({share}%), 구매 가능성 {infer_intent(p)}")
    funnel_line = '퍼널 데이터 없음'
    if funnel:
        biggest = funnel.get('biggest')
        funnel_line = f"총 {funnel.get('total', 0)}세션"
        if biggest:
            funnel_line += f", 최대 이탈 구간 {biggest[0]} {biggest[1]}명({biggest[2]}%)"
    commerce_line = json.dumps(commerce or {}, ensure_ascii=False)[:1800]
    return f"""당신은 이커머스 운영 책임자에게 주간 의사결정 메모를 작성하는 분석가입니다.
아래 관측값만 사용해 '종합 제안'을 작성하세요.

[고객 유형]
{chr(10).join(types)}
[구매 여정] {funnel_line}
[상품 행동 요약] {commerce_line}

작성 규칙:
- 한국어 4문장, 번호·제목·마크다운 없이 하나의 단락으로 작성합니다.
- 첫 문장은 이번 주 가장 중요한 기회 또는 위험을 수치 근거와 함께 요약합니다.
- 둘째·셋째 문장은 우선순위가 다른 실행안 2개를 각각 '대상 고객/화면 + 변경 내용 + 이유'가 보이게 씁니다.
- 마지막 문장은 다음 주 비교할 검증 지표를 명시합니다.
- 데이터에 없는 원인, 상품명, 매출 효과, 목표 수치를 만들지 말고 데이터가 없으면 그 한계를 짧게 밝힙니다.
- 일반론(서비스를 개선하세요, 마케팅을 강화하세요) 대신 실행 위치와 내용을 구체적으로 씁니다."""


def build_usage_prompt(profiles: dict, total_visits: int) -> str:
    rows = []
    for cid in sorted(profiles.keys(), key=int):
        p = profiles[cid]
        acts = ', '.join(ko_action(a['action']) for a in meaningful_actions(p, 3)) or '행동 정보 부족'
        rows.append(f"- {p.get('name', type_name(cid, p))}: {p.get('count', 0)}건, {infer_intent(p)}, 대표 행동 {acts}")
    return f"""당신은 쇼핑몰 CRM·콘텐츠 운영 실무자입니다. 아래 고객 행동 유형을 실제 운영에 연결하는 '활용 제안'을 작성하세요.

[총 방문] {total_visits}건
{chr(10).join(rows)}

작성 규칙:
- 한국어 3문장, 번호·제목·마크다운 없이 하나의 단락으로 작성합니다.
- 각 문장은 서로 다른 활용 영역(사이트 개인화, 재방문 메시지, 콘텐츠/프로모션 실험) 중 하나를 다룹니다.
- 각 문장에 대상 유형, 실행 조건 또는 노출 위치, 메시지/콘텐츠, 확인 지표를 포함합니다.
- 개인정보나 인구통계를 추정하지 않고, 관측된 행동으로만 대상을 정의합니다.
- 입력에 없는 채널·상품명·성과 수치를 만들지 않습니다. 표본이 작을 수 있으므로 확정 표현 대신 실험·검증 표현을 씁니다."""

# ── 구매 의향 추론 ────────────────────────────────────────────────────────────
# 행동 비율 기반으로 구매 의향(높음/중간/낮음)을 추론한다
def infer_intent(profile: dict) -> str:
    acts  = {a['action']: a['count'] for a in profile.get('top_actions', [])}
    # generic 인터랙션을 뺀 "의미 있는 행동" 기준으로 비율 계산 (변별력 확보)
    total = sum(c for a, c in acts.items() if a not in GENERIC_ACTIONS) or 1
    buy   = acts.get('ADD_CART', 0) + acts.get('CLICK_BUY', 0)
    leave = acts.get('TAB_OUT', 0)  + acts.get('EXIT_BOUNCE', 0) + acts.get('INACTIVE', 0)
    if buy / total > 0.08:
        return '높음'
    elif leave / total > 0.25:
        return '낮음'
    return '중간'

# ── 고객 유형 이름 자동 생성 ───────────────────────────────────────────────────
# 행동 패턴 비율로 고객 유형 이름을 자동 분류한다 — 이미 통합된 유형은 그대로 반환
def type_name(cid: str, profile: dict) -> str:
    if profile.get('name'):          # 이미 통합된 유형이면 그대로 사용
        return profile['name']
    acts  = {a['action']: a['count'] for a in profile.get('top_actions', [])}
    pages = profile.get('page_dist', {})
    total = sum(acts.values()) or 1
    buy   = (acts.get('ADD_CART', 0) + acts.get('CLICK_BUY', 0)) / total
    price = (acts.get('SCROLL_PRICE', 0) + acts.get('CHECK_PRICE', 0)) / total
    leave = (acts.get('TAB_OUT', 0) + acts.get('EXIT_BOUNCE', 0)) / total
    review= acts.get('VIEW_REVIEW', 0) / total
    img   = acts.get('VIEW_IMAGE', 0) / total
    cart  = acts.get('ADD_CART', 0) / total
    all_p = sum(pages.values()) or 1

    if buy > 0.15 or cart > 0.1:
        return '구매 결정형'
    elif price > 0.2:
        return '가격 비교형'
    elif leave > 0.25:
        return '탐색 중지 위험형'
    elif review > 0.08:
        return '신중 탐색형'
    elif img > 0.1:
        return '비주얼 탐색형'
    elif pages.get('PRODUCT', 0) / all_p > 0.7:
        return '상품 집중형'
    elif pages.get('HOME', 0) / all_p > 0.5:
        return '홈 체류형'
    else:
        return '일반 탐색형'

# ── 차트 → base64 PNG ─────────────────────────────────────────────────────────
# BytesIO 버퍼를 base64 문자열로 변환해 HTML img src에 직접 삽입할 수 있게 한다
def b64(buf: BytesIO) -> str:
    buf.seek(0)
    return base64.b64encode(buf.read()).decode()

def chart_distribution(profiles: dict) -> str:
    """전체 방문 비율 도넛 차트"""
    cids   = sorted(profiles.keys(), key=int)
    labels = [profiles[c].get('name', f"유형 {c}") for c in cids]
    sizes  = [profiles[c].get('count', 0) for c in cids]

    fig, ax = plt.subplots(figsize=(5.5, 4.5), facecolor='white')
    wedges, texts, autotexts = ax.pie(
        sizes, labels=labels, autopct='%1.1f%%',
        colors=PALETTE[:len(sizes)], startangle=90,
        pctdistance=0.8,
        wedgeprops=dict(width=0.52, edgecolor='white', linewidth=2),
    )
    for t in texts:      t.set_fontsize(7.5)
    for at in autotexts: at.set_fontsize(7); at.set_fontweight('bold')
    ax.set_title('고객 유형별 방문 비율', fontsize=12, fontweight='bold', pad=14)
    fig.tight_layout()
    buf = BytesIO(); fig.savefig(buf, format='png', dpi=140, bbox_inches='tight'); plt.close(fig)
    return b64(buf)

def chart_actions(cid: str, profile: dict) -> str:
    """상위 행동 가로 바 차트 (특성 행동 우선)"""
    actions = meaningful_actions(profile, 7)
    if not actions:
        return ''
    labels = [ko_action(a['action']) for a in reversed(actions)]
    values = [a['count'] for a in reversed(actions)]
    color  = PALETTE[int(cid) % len(PALETTE)]

    fig, ax = plt.subplots(figsize=(7, 3.2), facecolor='white')
    bars = ax.barh(labels, values, color=color, alpha=0.85, height=0.6)
    for bar, val in zip(bars, values):
        ax.text(bar.get_width() + max(values) * 0.02,
                bar.get_y() + bar.get_height() / 2,
                str(val), va='center', fontsize=8.5, color='#37474F')
    ax.set_xlabel('횟수', fontsize=8.5)
    ax.set_title('주요 행동 TOP 7', fontsize=10.5, fontweight='bold')
    ax.spines[['top','right']].set_visible(False)
    ax.tick_params(labelsize=9)
    ax.set_xlim(0, max(values) * 1.15)
    fig.tight_layout()
    buf = BytesIO(); fig.savefig(buf, format='png', dpi=140, bbox_inches='tight'); plt.close(fig)
    return b64(buf)

def chart_pages(cid: str, profile: dict) -> str:
    """페이지 분포 파이 차트"""
    pd = profile.get('page_dist', {})
    if not pd:
        return ''
    labels = [ko_page(k) for k in pd]
    sizes  = list(pd.values())
    PAGE_CLR = {
        '홈 화면':'#6F64B3','상품 상세':'#39248D','장바구니':'#557F75',
        '결제 페이지':'#D1BD5C','검색 결과':'#9C94CE','카테고리':'#D88924',
    }
    clrs = [PAGE_CLR.get(l, '#78909C') for l in labels]

    fig, ax = plt.subplots(figsize=(4, 3.5), facecolor='white')
    ax.pie(sizes, labels=labels, colors=clrs, autopct='%1.0f%%',
           startangle=90, pctdistance=0.78,
           wedgeprops=dict(edgecolor='white', linewidth=1.5),
           textprops={'fontsize': 8.5})
    ax.set_title('페이지별 방문 비율', fontsize=10, fontweight='bold')
    fig.tight_layout()
    buf = BytesIO(); fig.savefig(buf, format='png', dpi=140, bbox_inches='tight'); plt.close(fig)
    return b64(buf)

# ── 전환 퍼널 계산 ─────────────────────────────────────────────────────────────
FUNNEL_STAGES = ['방문', '상품 조회', '장바구니', '결제 도달', '구매 클릭']

# 세션 시퀀스에서 도달한 가장 깊은 퍼널 단계(0~4)를 반환한다
def _furthest_stage(seq: str) -> int:
    pages, sems = set(), set()
    for tok in seq.split():
        p = tok.split('|')
        if len(p) == 3:
            pages.add(p[0]); sems.add(p[1])
    lvl = 0
    if 'PRODUCT' in pages or 'VIEW_PRODUCT' in sems:        lvl = max(lvl, 1)
    if {'ADD_CART', 'ENTER_CART'} & sems or 'CART' in pages: lvl = max(lvl, 2)
    if 'CHECKOUT' in pages:                                 lvl = max(lvl, 3)
    if 'CLICK_BUY' in sems:                                 lvl = max(lvl, 4)
    return lvl

def compute_funnel(session_path: str, cluster_path: str, cid_to_name: dict):
    """세션 시퀀스로 전환 퍼널 계산. 세션 파일 없으면 None 반환(퍼널 페이지 생략)."""
    import csv as _csv
    if not os.path.exists(session_path):
        return None
    s2c = {}
    if os.path.exists(cluster_path):
        with open(cluster_path, encoding='utf-8-sig') as f:
            for r in _csv.DictReader(f):
                try:    s2c[r['session_id']] = str(int(float(r['cluster'])))
                except Exception: pass
    reach = [0] * 5; total = 0
    type_furthest = {}
    with open(session_path, encoding='utf-8-sig') as f:
        for r in _csv.DictReader(f):
            seq = r.get('sequence', '') or ''
            if not seq.strip():
                continue
            total += 1
            fz = _furthest_stage(seq)
            for L in range(5):
                if fz >= L: reach[L] += 1
            nm = cid_to_name.get(s2c.get(r['session_id']), '미분류')
            type_furthest.setdefault(nm, []).append(fz)
    if total == 0:
        return None
    drops = [(FUNNEL_STAGES[L], reach[L-1]-reach[L],
              round(100*(reach[L-1]-reach[L])/reach[L-1]) if reach[L-1] else 0)
             for L in range(1, 5)]
    biggest = max(drops, key=lambda x: x[1]) if drops else None
    leak_lvl = FUNNEL_STAGES.index(biggest[0]) - 1 if biggest else 0
    stall = {nm: sum(1 for x in lv if x == leak_lvl) for nm, lv in type_furthest.items()}
    _named = {k: v for k, v in stall.items() if k != '미분류'}
    _pool = _named if (_named and max(_named.values()) > 0) else stall
    leak_type = max(_pool, key=_pool.get) if _pool and max(_pool.values()) > 0 else None

    # ── 유형별 퍼널 통계 (구매가능성의 근거가 됨) ──
    by_type = {}
    for nm, lv in type_furthest.items():
        n = len(lv)
        by_type[nm] = {
            'n': n,
            'cart_rate':  round(100 * sum(1 for x in lv if x >= 2) / n),
            'chk_rate':   round(100 * sum(1 for x in lv if x >= 3) / n),
            'buy_rate':   round(100 * sum(1 for x in lv if x >= 4) / n),
            'stall_leak': sum(1 for x in lv if x == leak_lvl),
        }
    # 전체 평균 구매클릭 도달율 → 상대 등급 기준
    avg_buy = round(100 * reach[4] / total)
    return {'total': total, 'reach': reach,
            'rates': [round(100*n/total) for n in reach],
            'drops': drops, 'biggest': biggest, 'leak_type': leak_type,
            'by_type': by_type, 'avg_buy': avg_buy}

# 퍼널 구매클릭 도달율 → 구매 가능성 상대 등급
# 구매클릭 도달율을 전체 평균과 비교해 구매 가능성 등급을 반환한다
def intent_from_funnel(buy_rate: float, avg_buy: float) -> str:
    hi = max(avg_buy * 1.2, 15)
    lo = avg_buy * 0.6
    if buy_rate >= hi:  return '높음'
    if buy_rate <= lo:  return '낮음'
    return '중간'

def type_intent(name: str, profile: dict, funnel: dict) -> str:
    """구매 가능성: 퍼널 데이터가 있으면 유형별 구매클릭 도달율 기준(일관/정의 명확),
    없으면 행동 휴리스틱으로 폴백."""
    if funnel and name in funnel.get('by_type', {}):
        return intent_from_funnel(funnel['by_type'][name]['buy_rate'], funnel['avg_buy'])
    return infer_intent(profile)

# 퍼널 단계별 도달율을 가로 막대 차트로 그려 base64 PNG를 반환한다
def chart_funnel(funnel: dict) -> str:
    stages, reach, total = FUNNEL_STAGES, funnel['reach'], funnel['total']
    fig, ax = plt.subplots(figsize=(8, 3.6), facecolor='white')
    colors = ['#3949AB', '#3f51b5', '#5c6bc0', '#e65100', '#b71c1c']
    y = list(range(len(stages)))[::-1]
    for i, (s, n) in enumerate(zip(stages, reach)):
        rate = 100*n/total if total else 0
        ax.barh(y[i], rate, color=colors[i], height=0.62, alpha=0.9)
        ax.text(min(rate+1, 101), y[i], f"  {n}명 ({rate:.0f}%)",
                va='center', fontsize=9, color='#37474f')
    ax.set_yticks(y); ax.set_yticklabels(stages, fontsize=10)
    ax.set_xlim(0, 118); ax.set_xlabel('도달율 (%)', fontsize=9)
    ax.spines[['top', 'right']].set_visible(False)
    ax.set_title('전환 퍼널 — 단계별 도달율', fontsize=11.5, fontweight='bold')
    fig.tight_layout()
    buf = BytesIO(); fig.savefig(buf, format='png', dpi=140, bbox_inches='tight'); plt.close(fig)
    return b64(buf)

# ── HTML 빌드 ─────────────────────────────────────────────────────────────────
# 표지·요약·퍼널·클러스터·제안·방법론 페이지를 조합해 완성된 HTML 문자열을 반환한다
def build_html(start: str, end: str, profiles: dict,
               ai_reports: dict, font_reg: str, font_bold: str,
               funnel: dict = None, exit_captures: list = None,
               marketing_html: str = '', commerce: dict = None,
               site_name: str = '쇼핑몰', overall_insight: str = '',
               usage_insight: str = '') -> str:

    total_visits = sum(p.get('count', 0) for p in profiles.values())
    _intent = {c: type_intent(type_name(c, p), p, funnel) for c, p in profiles.items()}
    high_intent  = sum(1 for c in profiles if _intent[c] == '높음')
    dist_chart   = chart_distribution(profiles)

    # ── CSS ──────────────────────────────────────────────────────────────────
    css = f"""
@font-face {{
    font-family: 'NanumGothic';
    src: url('file://{font_reg}');
    font-weight: normal;
}}
@font-face {{
    font-family: 'NanumGothic';
    src: url('file://{font_bold}');
    font-weight: bold;
}}
@page {{
    size: A4;
    margin: 0;
}}
* {{
    font-family: 'NanumGothic', sans-serif;
    box-sizing: border-box;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
}}
body {{ margin: 0; padding: 0; background: #fff; }}

/* ── 페이지 공통 ── */
.page {{
    width: 210mm;
    min-height: 297mm;
    page-break-after: always;
    position: relative;
    overflow: hidden;
    background:
        radial-gradient(circle at top right, rgba(86, 100, 210, 0.08), transparent 28%),
        linear-gradient(180deg, #fcfdff 0%, #ffffff 100%);
}}
.page::before {{
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3.2mm;
    background: linear-gradient(90deg, #1a237e 0%, #4f6bff 55%, #7dd3fc 100%);
}}

/* ── 표지 ── */
.cover {{
    background: linear-gradient(160deg, #1a237e 0%, #283593 55%, #3949AB 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: white;
    text-align: center;
    padding: 30mm 20mm;
}}
.cover::before {{
    content: '';
    position: absolute;
    width: 80mm;
    height: 80mm;
    top: -12mm;
    right: -10mm;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 72%);
}}
.cover::after {{
    content: '';
    position: absolute;
    width: 58mm;
    height: 58mm;
    bottom: 18mm;
    left: -8mm;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(125,211,252,0.18) 0%, rgba(125,211,252,0) 72%);
}}
.cover .logo-line {{
    font-size: 13pt;
    letter-spacing: 4px;
    opacity: 0.88;
    text-transform: uppercase;
    margin-bottom: 6mm;
    background: rgba(255,255,255,0.12);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 999px;
    padding: 2.2mm 5mm;
}}
.cover .main-title {{
    font-size: 28pt;
    font-weight: bold;
    line-height: 1.24;
    margin-bottom: 5.5mm;
}}
.cover .sub-title {{
    font-size: 13pt;
    opacity: 0.9;
    margin-bottom: 12mm;
}}
.cover .period-box {{
    background: rgba(255,255,255,0.14);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 999px;
    padding: 4mm 10mm;
    font-size: 10.5pt;
    margin-bottom: 16mm;
}}
.cover .divider {{
    width: 30mm;
    height: 2px;
    background: rgba(255,255,255,0.4);
    margin: 0 auto 10mm;
}}
.cover .kpi-row {{
    display: flex;
    gap: 8mm;
    margin-top: 4mm;
}}
.cover .kpi-item {{
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.14);
    border-radius: 12px;
    padding: 4.5mm 8mm;
    min-width: 40mm;
    text-align: center;
}}
.cover .kpi-val {{
    font-size: 21pt;
    font-weight: bold;
    display: block;
}}
.cover .kpi-lbl {{
    font-size: 8pt;
    opacity: 0.82;
    margin-top: 1.4mm;
    display: block;
}}
.cover .footer-line {{
    position: absolute;
    bottom: 10mm;
    width: 100%;
    text-align: center;
    font-size: 8pt;
    opacity: 0.5;
}}

/* ── 공통 페이지 헤더 ── */
.page-header {{
    background: linear-gradient(90deg, #18216d 0%, #24328f 55%, #3046b5 100%);
    color: white;
    padding: 5.5mm 12mm 5mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid rgba(255,255,255,0.12);
}}
.page-header .brand {{
    font-size: 8pt;
    letter-spacing: 2px;
    opacity: 0.9;
    background: rgba(255,255,255,0.12);
    padding: 1.4mm 3mm;
    border-radius: 999px;
}}
.page-header .page-title {{ font-size: 13pt; font-weight: bold; }}
.page-header .period {{ font-size: 8pt; opacity: 0.75; }}

/* ── 공통 콘텐츠 영역 ── */
.page-body {{ padding: 9mm 12mm 8mm; }}
.keep-block, .chart-center, .summary-kpi-row, .charts-row, .insight-box, .type-header, .stats-row {{
    break-inside: avoid;
    page-break-inside: avoid;
}}
.section-block {{
    break-inside: avoid;
    page-break-inside: avoid;
    margin-bottom: 5mm;
}}

/* ── 요약 페이지 ── */
.summary-lead {{
    background: linear-gradient(135deg, #f5f7ff 0%, #eef3ff 100%);
    border: 1px solid #dbe4ff;
    border-radius: 14px;
    padding: 5.5mm 6mm;
    margin-bottom: 6mm;
}}
.summary-lead .eyebrow {{
    display: inline-block;
    font-size: 8pt;
    font-weight: bold;
    color: #2940b5;
    background: #e8edff;
    border-radius: 999px;
    padding: 1.2mm 3mm;
    margin-bottom: 2.4mm;
}}
.summary-lead .headline {{
    font-size: 14pt;
    font-weight: bold;
    color: #162252;
    line-height: 1.45;
    margin-bottom: 2mm;
}}
.summary-lead .copy {{
    font-size: 9pt;
    color: #4b5b72;
    line-height: 1.8;
}}
.summary-kpi-row {{
    display: flex;
    gap: 5mm;
    margin-bottom: 7mm;
}}
.kpi-card {{
    flex: 1;
    border-radius: 12px;
    padding: 5.2mm 6mm;
    text-align: left;
    border: 1px solid #d9e1ff;
    border-top: 4px solid;
    box-shadow: 0 4px 14px rgba(26, 35, 126, 0.06);
}}
.kpi-card.blue   {{ background:linear-gradient(180deg, #f3f5ff 0%, #edf1ff 100%); border-color:#4f6bff; }}
.kpi-card.green  {{ background:linear-gradient(180deg, #eefbf3 0%, #e8f7ef 100%); border-color:#2e7d32; }}
.kpi-card.orange {{ background:linear-gradient(180deg, #fff8ef 0%, #fff2df 100%); border-color:#e67e22; }}
.kpi-card .card-val {{ font-size: 23pt; font-weight: bold; color: #162252; }}
.kpi-card .card-lbl {{ font-size: 8.5pt; color: #607086; margin-top: 1.4mm; }}

/* ── 상품 행동 데이터 ── */
.commerce-kpis {{ display:grid; grid-template-columns:repeat(3, 1fr); gap:3mm; margin-bottom:6mm; }}
.commerce-kpi {{ border:1px solid #dbe4ff; border-radius:10px; padding:4mm; background:linear-gradient(180deg,#fff,#f5f8ff); }}
.commerce-kpi .label {{ color:#607086; font-size:7.8pt; }}
.commerce-kpi .value {{ color:#162252; font-size:18pt; font-weight:bold; margin-top:1.5mm; }}
.commerce-cols {{ display:grid; grid-template-columns:1.1fr 0.9fr; gap:5mm; }}
.commerce-box {{ border:1px solid #dfe6f0; border-radius:11px; background:#fff; padding:4mm; }}
.commerce-box h3 {{ margin:0 0 3mm; color:#162252; font-size:9.5pt; }}
.commerce-row {{ display:flex; justify-content:space-between; gap:4mm; padding:2.2mm 0; border-bottom:1px solid #edf1f6; font-size:8.2pt; }}
.commerce-row:last-child {{ border-bottom:0; }}
.commerce-row .name {{ color:#24324a; }}
.commerce-row .meta {{ color:#748297; white-space:nowrap; }}
.commerce-note {{ margin-top:5mm; padding:4mm 5mm; border:1px solid #cfe0ff; border-radius:10px; background:#f4f8ff; color:#315b9a; font-size:8.2pt; line-height:1.7; }}

.section-title {{
    font-size: 11pt;
    font-weight: bold;
    color: #162252;
    border-left: 4px solid #4f6bff;
    padding: 0.3mm 0 0.3mm 3mm;
    margin-bottom: 5mm;
    break-after: avoid;
    page-break-after: avoid;
}}
.chart-center {{ text-align: center; }}
.chart-center img {{ max-width: 130mm; }}

/* ── 클러스터 상세 페이지 ── */
.type-header {{
    background: linear-gradient(135deg, #162252 0%, #24328f 56%, #4f6bff 100%);
    color: white;
    padding: 5.4mm 10mm;
    border-radius: 14px;
    margin-bottom: 5mm;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 8px 18px rgba(26, 35, 126, 0.16);
}}
.type-header .type-num {{ font-size: 9pt; opacity: 0.75; }}
.type-header .type-name {{ font-size: 16pt; font-weight: bold; margin-top: 1mm; }}
.type-header .type-count {{ font-size: 9pt; opacity: 0.86; margin-top: 1.3mm; }}
.intent-badge {{
    font-size: 10.5pt;
    font-weight: bold;
    padding: 2.2mm 5mm;
    border-radius: 999px;
    white-space: nowrap;
    border: 1px solid rgba(255,255,255,0.18);
}}
.stats-row {{
    display: flex;
    gap: 4mm;
    margin-bottom: 5mm;
}}
.stat-chip {{
    background: linear-gradient(180deg, #f9fbff 0%, #f3f6ff 100%);
    border: 1px solid #d6dfff;
    border-radius: 10px;
    padding: 2.8mm 5mm;
    font-size: 8.5pt;
    color: #37474f;
}}
.stat-chip b {{ color: #1a237e; }}

.charts-row {{
    display: flex;
    gap: 5mm;
    margin-bottom: 5mm;
    align-items: flex-start;
}}
.chart-box {{
    background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
    border: 1px solid #e3e9ff;
    border-radius: 12px;
    padding: 3.5mm;
    text-align: center;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.6);
}}
.chart-box img {{ max-width: 100%; }}

.insight-box {{
    background: linear-gradient(180deg, #f8faff 0%, #f3f6ff 100%);
    border: 1px solid #dfe6ff;
    border-left: 4px solid #4f6bff;
    border-radius: 12px;
    padding: 5mm 6mm;
    font-size: 9.5pt;
    line-height: 1.8;
    color: #263238;
    box-shadow: 0 4px 12px rgba(26, 35, 126, 0.05);
}}
.insight-label {{
    font-size: 8.5pt;
    font-weight: bold;
    color: #2940b5;
    margin-bottom: 3mm;
    display: flex;
    align-items: center;
    gap: 2mm;
}}
.insight-label::before {{
    content: '●';
    color: #4f6bff;
}}

/* ── 제안 페이지 ── */
.rec-table {{
    width: 100%;
    border-collapse: collapse;
    font-size: 8.5pt;
    margin-top: 4mm;
    break-inside: avoid;
    page-break-inside: avoid;
}}
.rec-table th {{
    background: linear-gradient(90deg, #18216d 0%, #24328f 100%);
    color: white;
    padding: 3mm 4mm;
    text-align: left;
    font-size: 9pt;
}}
.rec-table td {{
    padding: 3mm 4mm;
    border-bottom: 1px solid #e8eaf6;
    vertical-align: top;
    line-height: 1.6;
}}
.rec-table tr:nth-child(even) td {{ background: #f5f7ff; }}
.badge-high   {{ background:#e8f5e9; color:#2e7d32; padding:1.2px 7px; border-radius:999px; font-size:8pt; white-space:nowrap; border:1px solid #c8e6c9; }}
.badge-mid    {{ background:#fff3e0; color:#e65100; padding:1.2px 7px; border-radius:999px; font-size:8pt; white-space:nowrap; border:1px solid #ffd8a8; }}
.badge-low    {{ background:#ffebee; color:#b71c1c; padding:1.2px 7px; border-radius:999px; font-size:8pt; white-space:nowrap; border:1px solid #ffcdd2; }}

/* SEER 운영자 화면과 동일한 밝은 카드형 리포트 테마 */
.page {{
    background: linear-gradient(180deg, #fbfcff 0%, #f6f8fb 100%);
}}
.page::before {{
    background: linear-gradient(90deg, #185adb 0%, #0f7ae5 58%, #14b8a6 100%);
}}
.cover {{ display:block; text-align:left; padding:0; color:#fff; background:#17407a; }}
.cover::before, .cover::after {{ display:none; }}
.cover .cover-triangle {{ position:absolute; right:0; width:0; height:0; }}
.cover .triangle-top-1 {{ top:0; border-top:148mm solid #1f4c8c; border-left:148mm solid transparent; }}
.cover .triangle-top-2 {{ top:0; border-top:79mm solid #3d6bb0; border-left:79mm solid transparent; }}
.cover .triangle-bottom-1 {{ bottom:0; border-bottom:127mm solid #1f4c8c; border-left:127mm solid transparent; }}
.cover .triangle-bottom-2 {{ bottom:0; border-bottom:79mm solid #3d6bb0; border-left:79mm solid transparent; }}
.cover .triangle-bottom-3 {{ bottom:0; border-bottom:40mm solid #8aa5d8; border-left:40mm solid transparent; }}
.cover .logo-line {{ position:absolute; left:15mm; top:17mm; margin:0; padding:0; border:0; background:transparent; color:#bcd3f5; font-size:12pt; font-weight:bold; letter-spacing:3px; text-transform:uppercase; }}
.cover .cover-accent {{ position:absolute; left:15mm; top:92mm; width:17mm; height:1.6mm; background:#e0852a; border-radius:2mm; }}
.cover .main-title {{ position:absolute; left:15mm; top:100mm; margin:0; color:#fff; font-size:45pt; line-height:1.2; font-weight:bold; }}
.cover .site-name {{ position:absolute; left:15mm; top:148mm; color:#fff; font-size:19pt; font-weight:bold; }}
.cover .week-label {{ position:absolute; left:15mm; top:160mm; color:#d6e4fa; font-size:12pt; }}
.cover .period-box {{ position:absolute; left:15mm; bottom:17mm; width:80mm; margin:0; padding:3mm 0 0; border:0; border-top:1px solid #5b80b8; border-radius:0; background:transparent; box-shadow:none; color:#fff; font-size:15pt; font-weight:bold; }}
.cover .period-label {{ display:block; margin-bottom:2mm; color:#bcd3f5; font-size:9pt; font-weight:bold; letter-spacing:2px; }}
.page-header {{
    background:#fff; color:#172033; border-bottom:1px solid #dde7f2;
    padding:0; display:block; position:relative; height:18.5mm;
}}
.page-header .brand {{ position:absolute; left:12mm; top:5.3mm; color:#185adb; opacity:1; background:#e9f1ff; }}
.page-header .page-title {{ position:absolute; left:45mm; right:45mm; top:5.1mm; text-align:center; white-space:nowrap; }}
.page-header .period {{ position:absolute; right:12mm; top:6mm; color:#65758b; opacity:1; white-space:nowrap; }}
.summary-lead {{ background:linear-gradient(135deg,#ffffff,#eef5ff 65%,#ecfbf8); border-color:#dde7f2; box-shadow:0 8px 24px rgba(23,32,51,.06); }}
.section-title {{ color:#172033; border-left-color:#185adb; }}
.type-header {{ background:linear-gradient(135deg,#172033,#185adb 72%,#0f7ae5); }}
.insight-box {{ background:#fff; border-color:#dde7f2; border-left-color:#14b8a6; }}
.rec-table {{ background:#fff; border:1px solid #dde7f2; }}
.rec-table th {{ background:#172033; }}
.rec-table tr:nth-child(even) td {{ background:#f6f8fb; }}

/* 첨부 주간 리포트 본문 디자인 시스템 */
.page {{
    height:auto; min-height:294mm; background:#fff; color:#102c56;
    overflow:hidden; break-inside:avoid; page-break-inside:avoid;
    break-after:page !important; page-break-after:always !important;
}}
.page + .page {{ break-before:page; page-break-before:always; }}
.cluster-page {{
    height:297mm; min-height:297mm;
    break-after:auto !important; page-break-after:auto !important;
}}
.cluster-page > .page-header {{ display:none; }}
.cluster-page > .page-body {{ padding-top:0; }}
.cluster-page .manual-report-header {{ display:none; }}
.cluster-page .type-header {{
    margin-top:0; padding:0; background:#fff; display:block;
    break-before:page; page-break-before:always;
}}
.cluster-page .type-header::before {{ display:none; }}
.embedded-report-header {{ height:43mm; color:#174985; }}
.embedded-report-top {{ position:relative; height:20mm; padding-top:13mm; font-size:8pt; }}
.embedded-brand {{ position:absolute; left:0; top:13mm; font-weight:bold; letter-spacing:2.4px; }}
.embedded-date {{ position:absolute; right:0; top:13mm; color:#425b7d; }}
.embedded-rule {{ height:.45mm; background:#174985; }}
.embedded-title {{ margin-top:9mm; color:#174985; font-size:22pt; font-weight:bold; }}
.type-banner-main {{
    display:flex; align-items:center; justify-content:space-between;
    padding:5mm 8mm; background:#39248d; color:#fff;
}}
.cluster-index-1 .type-banner-main {{ position:relative; margin-top:18mm; }}
.cluster-index-1 .type-banner-main::before {{
    content:'고객 유형 상세 분석'; position:absolute; left:0; right:0; top:-18mm;
    height:14mm; padding-top:2mm; box-sizing:border-box; background:#fff;
    border-bottom:.45mm solid #174985; color:#174985; font-size:22pt; font-weight:bold;
}}
.page::before {{ display:none; }}
.page-header {{
    height:43mm; padding:0 15mm; border:0; background:#fff; color:#123f79;
}}
.page-header::after {{
    content:''; position:absolute; left:15mm; right:15mm; top:21.5mm;
    height:.45mm; background:#174985;
}}
.page-header .brand {{
    left:15mm; top:13mm; padding:0; border-radius:0; background:transparent;
    color:#174985; font-size:8pt; font-weight:bold; letter-spacing:2.4px;
}}
.page-header .brand::after {{ content:' ANALYTICS'; }}
.page-header .period {{ right:15mm; top:13.3mm; color:#425b7d; font-size:8pt; }}
.page-header .page-title {{
    left:15mm; right:15mm; top:31mm; text-align:left; color:#123f79;
    font-size:22pt; line-height:1; font-weight:bold;
}}
.page-body {{ padding:5mm 15mm 17mm; }}
.section-title {{
    border:0; padding:0; margin:0 0 4mm; color:#102c56; font-size:14pt;
    line-height:1.3;
}}
.section-title::before {{ display:none; }}
.summary-lead {{
    padding:0; margin:0 0 6mm; border:0; border-radius:0; background:#fff; box-shadow:none;
}}
.summary-lead .eyebrow {{ display:none; }}
.summary-lead .headline {{ color:#123f79; font-size:16pt; margin:0; }}
.summary-lead .copy {{ color:#233c60; }}
.summary-kpi-row {{ gap:3mm; margin-bottom:6mm; }}
.summary-kpi-row .kpi-card:nth-child(4) {{ background:#f3ded2; }}
.kpi-card, .kpi-card.blue, .kpi-card.green, .kpi-card.orange {{
    padding:4mm 4.5mm; border:0; border-radius:0; background:#edf1f7;
    box-shadow:none; min-height:28mm;
}}
.kpi-card.orange {{ background:#f3ded2; }}
.kpi-card .card-val {{ color:#123f79; font-size:24pt; line-height:1.1; }}
.kpi-card.orange .card-val {{ color:#a35b00; }}
.kpi-card .card-lbl {{ color:#425b7d; }}
.insight-box {{
    padding:5mm; border:1px solid #174985; border-left:1px solid #174985;
    border-radius:0; background:#fff; box-shadow:none; color:#142c4e;
}}
.insight-label {{
    display:inline-block; margin:-8mm 0 3mm -1mm; padding:1.2mm 3mm;
    background:#174985; color:#fff; font-size:8pt;
}}
.insight-label::before {{ display:none; }}
.type-header {{
    margin-bottom:4mm; padding:5mm 8mm; border-radius:0; box-shadow:none;
    background:#39248d;
}}
.type-header .type-num {{ color:#e9e5f8; opacity:1; }}
.type-header .type-name {{ color:#fff; font-size:17pt; }}
.type-header .type-count {{ color:#fff; opacity:1; }}
.intent-badge {{ border:0; border-radius:0; padding:2.5mm 4mm; }}
.stats-row {{ gap:3mm; margin-bottom:5mm; }}
.stat-chip {{
    flex:1; padding:3.5mm 4mm; border:0; border-radius:0;
    background:#f0eef8; color:#2f2861;
}}
.stat-chip b {{ color:#26166f; }}
.charts-row {{ gap:7mm; margin-bottom:7mm; }}
.chart-box {{ padding:0; border:0; border-radius:0; background:#fff; box-shadow:none; }}
.rec-table {{ border:0; margin-top:2mm; color:#142c4e; }}
.rec-table th {{
    padding:2.6mm 3mm; background:#fff; color:#24466d; border-bottom:1px solid #174985;
    font-size:8.5pt;
}}
.rec-table td {{ padding:2.5mm 3mm; border-bottom:0; line-height:1.5; }}
.rec-table tr:nth-child(even) td {{ background:#fff3d7; }}
.rec-table tr:nth-child(odd) td {{ background:#f8e4df; }}
.badge-high, .badge-mid, .badge-low {{ border:0; border-radius:0; background:transparent; font-weight:bold; }}
.badge-high {{ color:#2f7255; }} .badge-mid {{ color:#a35b00; }} .badge-low {{ color:#b43c24; }}
.commerce-kpis {{ grid-template-columns:repeat(6, 1fr); gap:2.5mm; }}
.commerce-kpi {{ border:0; border-radius:0; background:#edf1f7; padding:3.5mm 3mm; }}
.commerce-kpi:nth-child(4), .commerce-kpi:nth-child(6) {{ background:#f3ded2; }}
.commerce-kpi .value {{ color:#123f79; }}
.commerce-kpi:nth-child(4) .value, .commerce-kpi:nth-child(6) .value {{ color:#a35b00; }}
.commerce-cols {{ grid-template-columns:1fr; gap:4mm; }}
.commerce-box {{ border:0; border-radius:0; background:#fff; padding:0; }}
.commerce-box h3 {{ color:#102c56; font-size:13pt; margin-bottom:3mm; }}
.commerce-row {{ border-bottom:0; padding:1.6mm 0; }}
.recent-commerce {{ display:none; }}
.commerce-note {{ border:1px solid #174985; border-radius:0; background:#fff; color:#174985; }}
.category-row {{ display:grid; grid-template-columns:26mm 1fr 14mm; gap:4mm; align-items:center; font-size:8.5pt; margin-bottom:2mm; }}
.category-track {{ height:5mm; background:#edf1f7; }}
.category-fill {{ height:100%; background:#4e78b7; }}
.category-count {{ text-align:right; font-weight:bold; color:#123f79; }}
.page:not(.cover)::after {{
    content:'{html_lib.escape(site_name)} 쇼핑몰 · 주간 리포트';
    position:absolute; left:15mm; bottom:8mm; color:#36587f; font-size:7.5pt;
}}
.proposal-box {{
    margin-top:6mm !important; padding:5mm !important; border:1px solid #174985 !important;
    border-left:1px solid #174985 !important; border-radius:0 !important; background:#fff !important;
}}
.proposal-box .proposal-title {{
    display:inline-block; margin:-8mm 0 3mm -1mm !important; padding:1.2mm 3mm;
    background:#174985; color:#fff !important; font-size:8.5pt !important;
}}
.proposal-box.usage .proposal-title {{ background:#557f75; }}
.proposal-box.usage {{ border-color:#557f75 !important; }}
.manual-report-header {{ position:relative; height:43mm; margin:0; }}
.manual-report-header .manual-top {{
    position:relative; height:20mm; padding-top:13mm;
    color:#174985; font-size:8pt; letter-spacing:2.4px; font-weight:bold;
}}
.manual-report-header .manual-top > span:first-child {{ position:absolute; left:0; top:13mm; }}
.manual-report-header .manual-period {{ position:absolute; right:0; top:13mm; color:#425b7d; letter-spacing:0; font-weight:normal; }}
.manual-report-header .manual-rule {{ height:.45mm; margin-top:5.2mm; background:#174985; }}
.manual-report-header .manual-title {{ margin-top:9mm; color:#123f79; font-size:22pt; font-weight:bold; }}
.summary-page .page-body {{ padding-top:0; }}

/* 첨부 HTML의 794×1123 레이아웃을 A4에 그대로 환산한 최종 규격 */
.page-header {{ height:40mm; }}
.page-header::after {{ top:21.5mm; }}
.page-header .page-title {{ top:31mm; font-size:21pt; }}
.page-body {{ padding:4mm 15mm 17mm; }}
.page:not(.cover)::after {{ bottom:8.5mm; }}

/* 요약·액션 영역: 원본처럼 테두리 없는 평면 블록 */
.summary-page .summary-kpi-row {{ margin-top:4mm; }}
.summary-page .kpi-card {{ padding:4mm 4mm; min-height:25mm; }}
.summary-page .section-title {{ margin-top:5mm; }}
.summary-page ul {{ background:#f3f5f9 !important; border-left:4px solid #3d6bb0 !important;
    border-radius:0 !important; color:#1d2a44 !important; }}

/* 상품 행동 데이터: 원본의 단일 표 + 가로 막대 구조 */
.commerce-page .summary-lead {{ margin-bottom:6mm; }}
.commerce-page .summary-lead .headline {{ font-size:15pt; }}
.commerce-page .summary-lead .copy {{ display:none; }}
.commerce-page .commerce-kpis {{ margin-bottom:6mm; }}
.commerce-page .commerce-kpi {{ padding:3.2mm 2.7mm; min-height:20mm; }}
.commerce-page .commerce-kpi .label {{ font-size:7.5pt; white-space:nowrap; }}
.commerce-page .commerce-kpi .value {{ font-size:19pt; line-height:1.25; }}
.commerce-page .commerce-box h3 {{ margin:0 0 2mm; font-size:14pt; font-weight:bold; }}
.commerce-page .product-table {{ width:100%; border-collapse:collapse; margin-bottom:5mm; font-size:8.5pt; }}
.commerce-page .product-table th {{ padding:1.8mm 3mm; color:#4a5670; font-size:8pt; text-align:left; }}
.commerce-page .product-table th.num, .commerce-page .product-table td.num {{ width:16mm; text-align:center; }}
.commerce-page .product-table td {{ padding:1.6mm 3mm; border:0; }}
.commerce-page .product-table tr:nth-child(even) td {{ background:#f3f5f9; }}
.commerce-page .category-row {{ grid-template-columns:28mm 1fr 16mm; gap:3mm; margin-bottom:2.3mm; font-size:9pt; }}
.commerce-page .category-track {{ height:5.2mm; background:#eef2fa; }}
.commerce-page .category-fill {{ background:#3d6bb0; }}
.commerce-page .commerce-note {{ margin-top:4mm; padding:3.5mm 5mm; border:0; background:#e9edf4; color:#4a5670; }}

/* 고객 유형 상세: 원본의 54px 배너, 라벤더 정보칸, 보라색 차트 체계 */
.cluster-page {{ height:294mm; min-height:294mm; }}
.cluster-page .page-body {{ padding:0 15mm 17mm; }}
.embedded-report-header {{ height:40mm; }}
.embedded-title {{ margin-top:8mm; font-size:21pt; }}
.type-banner-main {{ min-height:25mm; padding:4.8mm 8mm; }}
.type-header {{ margin-bottom:3mm; }}
.type-header .type-num {{ font-size:8pt; }}
.type-header .type-name {{ font-size:17pt; margin-top:.5mm; }}
.type-header .type-count {{ font-size:8pt; margin-top:.7mm; }}
.stats-row {{ height:16mm; margin-bottom:3mm; }}
.stat-chip {{ padding:3mm 4mm; font-size:8.5pt; }}
.cluster-page .insight-box {{ padding:3.5mm 4mm; line-height:1.65; }}
.cluster-page .section-title {{ color:#332288; font-size:14pt; margin:4mm 0 2mm; }}
.cluster-page .charts-row {{ gap:6mm; margin-bottom:9mm; }}
.cluster-page .chart-box img {{ max-height:57mm; object-fit:contain; }}
.cluster-page .insight-label {{ background:#332288; }}
.cluster-page .insight-box {{ border-color:#332288; }}

/* 제안·방법론 표와 제안 박스의 원본 간격 */
.recommendations-page .rec-table, .method-page .rec-table {{ margin-top:2mm; }}
.recommendations-page .proposal-box {{ margin-top:5mm !important; }}
.method-page .insight-box {{ background:#fff; }}
.page.cover {{ background:#17407a; color:#fff; }}
.page.cover .main-title, .page.cover .site-name, .page.cover .period-box {{ color:#fff; }}
.cluster-page {{ break-after:page !important; page-break-after:always !important; }}
.cluster-page .type-header {{ break-before:auto; page-break-before:auto; }}
.cluster-index-1 .type-banner-main {{ margin-top:0; }}
.cluster-index-1 .type-banner-main::before {{ display:none; }}
.cluster-page > .page-header {{ display:block; }}
.cluster-page > .page-body {{ padding:4mm 15mm 17mm; }}
.cluster-page .embedded-report-header {{ display:none; }}
.page + .page {{ break-before:auto; page-break-before:auto; }}
.page, .cluster-page {{ height:297mm; min-height:297mm; }}
.cluster-page {{ break-before:auto !important; page-break-before:auto !important;
    break-after:auto !important; page-break-after:auto !important; }}
.cluster-index-0 > .page-header, .cluster-index-2 > .page-header, .cluster-index-4 > .page-header {{ display:none; }}
.cluster-index-0 > .page-body, .cluster-index-2 > .page-body, .cluster-index-4 > .page-body {{ padding-top:0; }}
.cluster-index-0 .embedded-report-header, .cluster-index-2 .embedded-report-header,
.cluster-index-4 .embedded-report-header {{ display:block; }}
.cluster-page > .page-header {{ display:none; }}
.cluster-page > .page-body {{ padding-top:0; }}
.cluster-page .embedded-report-header {{ display:block; }}
.cluster-page .type-header {{ break-before:page !important; page-break-before:always !important; }}
.cluster-index-1 .type-banner-main, .cluster-index-3 .type-banner-main {{ position:relative; margin-top:40mm; }}
.cluster-index-1 .type-banner-main::before, .cluster-index-3 .type-banner-main::before {{
    display:block; content:'고객 유형 상세 분석'; position:absolute; left:0; right:0; top:-20mm;
    height:16mm; padding-top:3mm; background:#fff; border-top:.45mm solid #174985;
    color:#174985; font-size:21pt; font-weight:bold;
}}
.cluster-index-1 .type-banner-main::after, .cluster-index-3 .type-banner-main::after {{
    content:'SEER ANALYTICS'; position:absolute; left:0; top:-38mm; color:#174985;
    font-size:8pt; font-weight:bold; letter-spacing:2.4px;
}}
    """

    # ── 표지 시안 A ───────────────────────────────────────────────────────────
    end_dt = datetime.strptime(end, '%Y-%m-%d')
    week_label = f"{end_dt.year}년 {end_dt.month}월 {(end_dt.day - 1) // 7 + 1}주차 운영 현황"
    start_display = datetime.strptime(start, '%Y-%m-%d').strftime('%Y.%m.%d')
    end_display = end_dt.strftime('%Y.%m.%d')
    cover_html = f"""
<div class="page cover">
  <div class="cover-triangle triangle-top-1"></div><div class="cover-triangle triangle-top-2"></div>
  <div class="cover-triangle triangle-bottom-1"></div><div class="cover-triangle triangle-bottom-2"></div><div class="cover-triangle triangle-bottom-3"></div>
  <div class="logo-line">SEER ANALYTICS</div>
  <div class="cover-accent"></div>
  <div class="main-title">고객 행동 분석<br>주간 리포트</div>
  <div class="site-name">{html_lib.escape(site_name)} 쇼핑몰</div>
  <div class="week-label">{week_label}</div>
  <div class="period-box"><span class="period-label">REPORT PERIOD</span>{start_display} – {end_display}</div>
</div>
"""

    # ── 요약 페이지 ───────────────────────────────────────────────────────────
    low_intent = sum(1 for c in profiles if _intent[c] == '낮음')
    total_high_visits = sum(profiles[c].get('count',0) for c in profiles if _intent[c] == '높음')
    high_pct = round(total_high_visits / total_visits * 100) if total_visits else 0

    # ── 핵심 요약 / 우선 조치 자동 생성 ──────────────────────────────────────
    PRIORITY_ACTION = {
        '구매 결정형': '결제 단계를 줄이고 무료배송·즉시 쿠폰으로 구매를 마무리시키세요.',
        '가격 비교형': '최저가 보장·적립금 문구를 가격 옆에 노출해 탐색 중지을 막으세요.',
        '신중 탐색형': '리뷰 수와 사이즈 가이드를 강화해 구매 결정을 앞당기세요.',
        '탐색 중지 위험형': '장바구니 복귀 쿠폰·재방문 알림으로 다시 불러오세요.',
        '상품 집중형': '함께 구매한 상품·코디 추천으로 결정을 도우세요.',
        '비주얼 탐색형': '고화질 이미지·영상 콘텐츠로 체류와 구매를 늘리세요.',
        '홈 체류형': '기획전 배너로 상품 페이지로 유도하세요.',
        '일반 탐색형': '첫 구매 혜택·회원가입으로 다음 방문을 노리세요.',
    }
    def _pick(grade):
        cand = [profiles[c] for c in profiles if (grade is None or _intent[c] == grade)]
        return max(cand, key=lambda x: x.get('count', 0)) if cand else None
    big_high = _pick('높음')
    big_risk = _pick('낮음')
    biggest  = _pick(None)
    summary_focus = []
    if biggest:
        summary_focus.append(f"가장 많은 고객은 {biggest['name']} 유형")
    if big_high:
        summary_focus.append(f"바로 전환을 노릴 고객은 {big_high['name']} 유형")
    if big_risk:
        summary_focus.append(f"먼저 막아야 할 흐름은 {big_risk['name']} 유형")
    summary_headline = ' · '.join(summary_focus[:2]) if summary_focus else '이번 주 고객 흐름을 유형 중심으로 정리했습니다.'
    summary_copy = (
        "숫자만 나열하기보다, 어떤 고객이 많았고 누구를 먼저 챙겨야 하는지 바로 읽히도록 정리한 페이지입니다. "
        "아래 KPI와 유형 요약을 먼저 보고, 다음 장의 퍼널과 상세 유형 분석으로 내려가면 운영 우선순위를 더 빠르게 잡을 수 있습니다."
    )
    _seen, _items = set(), []
    for tag, tp in [('지금 잡아야 할 고객', big_high),
                    ('새는 고객 막기', big_risk),
                    ('가장 많은 고객', biggest)]:
        if tp and tp['name'] not in _seen:
            _seen.add(tp['name'])
            sh = round(tp['count'] / total_visits * 100) if total_visits else 0
            act = PRIORITY_ACTION.get(tp['name'], '맞춤 안내·혜택으로 전환을 높이세요.')
            _items.append(f"<li><b>{tag} — {tp['name']}</b> (전체의 {sh}%): {act}</li>")
    priority_html = (
        '<div class="section-title">우선 조치</div>'
        '<ul style="font-size:9.5pt; line-height:1.9; color:#263238; '
        'background:#f5f7ff; border-left:4px solid #3949AB; '
        'padding:5mm 6mm 5mm 11mm; margin:0 0 6mm 0; border-radius:0 8px 8px 0;">'
        + ''.join(_items) + '</ul>'
    ) if _items else ''

    summary_html = f"""
<div class="page summary-page">
  <div class="page-body">
    <div class="manual-report-header">
      <div class="manual-top"><span>SEER ANALYTICS</span><span class="manual-period">{start} ~ {end}</span></div>
      <div class="manual-rule"></div><div class="manual-title">고객 유형 요약</div>
    </div>
    <div class="summary-lead">
      <div class="eyebrow">이번 주 핵심 포인트</div>
      <div class="headline">{summary_headline}</div>
    </div>

    <div class="summary-kpi-row">
      <div class="kpi-card blue">
        <div class="card-val">{total_visits:,}</div>
        <div class="card-lbl">분석 기간 방문 건수</div>
      </div>
      <div class="kpi-card green">
        <div class="card-val">{high_pct}%</div>
        <div class="card-lbl">구매 가능성 높은 방문 비율</div>
      </div>
      <div class="kpi-card orange">
        <div class="card-val">{len(profiles)}</div>
        <div class="card-lbl">발견된 고객 행동 유형 수</div>
      </div>
    </div>

    {priority_html}

    <div class="section-block">
      <div class="section-title">고객 유형별 방문 비율</div>
      <div class="chart-center">
        <img src="data:image/png;base64,{dist_chart}" style="max-width:92mm;" />
      </div>
    </div>
  </div>
</div>
"""

    summary_table_html = f"""
<div class="page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">고객 유형 한눈에 보기</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="section-block">
    <div class="section-title" style="margin-top:5mm;">고객 유형 한눈에 보기</div>
    <table class="rec-table">
      <tr>
        <th style="width:34mm;">고객 유형</th>
        <th style="width:16mm;">방문 건수</th>
        <th style="width:16mm;">전체 비율</th>
        <th style="width:22mm;">구매 가능성</th>
        <th>대표 행동</th>
      </tr>
"""
    for cluster_idx, cid in enumerate(sorted(profiles.keys(), key=int)):
        p    = profiles[cid]
        name = type_name(cid, p)
        cnt  = p.get('count', 0)
        intt = _intent[cid]
        share = round(cnt / total_visits * 100) if total_visits else 0
        ma   = meaningful_actions(p, 2)
        top1 = ' · '.join(ko_action(a['action']) for a in ma) if ma else '-'
        badge_cls = {'높음':'badge-high','중간':'badge-mid','낮음':'badge-low'}[intt]
        summary_table_html += f"""
      <tr>
        <td><b>{name}</b></td>
        <td style="text-align:center;">{cnt}건</td>
        <td style="text-align:center;">{share}%</td>
        <td><span class="{badge_cls}">{intt}</span></td>
        <td>{top1}</td>
      </tr>"""
    summary_table_html += """
    </table>
    <div style="font-size:7.5pt; color:#90a4ae; margin-top:3mm; line-height:1.6;">
      ※ 고객 유형은 세션 행동 패턴을 군집화하여 도출했습니다.
      구매 가능성은 실제 구매 완료가 아닌, 유형별 퍼널 하위 행동(장바구니·결제·구매 클릭) 도달율을 기준으로 한 상대 추정치입니다.
      모든 비율은 분석 기간 내 세션 기준입니다.
    </div>
    </div>
  </div>
</div>
"""

    # ── 전환 퍼널 페이지 (세션 데이터 있을 때만) ──────────────────────────────
    funnel_html = ''
    if funnel:
        fchart = chart_funnel(funnel)
        b  = funnel['biggest']; lt = funnel['leak_type']
        rates = funnel['rates']
        cart_rate = rates[2] if len(rates) > 2 else 0
        chk_rate  = rates[3] if len(rates) > 3 else 0
        buy_rate  = rates[4] if len(rates) > 4 else 0
        leak_line = (f"결제 단계까지 도달한 고객 중 가장 크게 빠져나가는 구간은 "
                     f"<b>‘{b[0]}’ 진입으로, {b[1]}명({b[2]}%)이 탐색 중지</b>합니다."
                     if b else "")
        leak_type_line = (f" 이 구간에서 주로 멈추는 고객은 <b>{lt}</b>으로 분류됩니다. "
                          f"이 유형을 겨냥한 조치가 전환 회복에 가장 효과적입니다."
                          if lt else "")
        drop_rows = ''.join(
            f"<tr><td>{s} 진입</td><td style='text-align:center;'>{d}명 탐색 중지</td>"
            f"<td style='text-align:center; color:#b71c1c; font-weight:bold;'>{p}%</td></tr>"
            for s, d, p in funnel['drops'])
        # 유형별 단계 도달율 (퍼널 ↔ 유형 연결)
        bt = funnel.get('by_type', {})
        bt_rows = ''.join(
            f"<tr><td><b>{nm}</b></td><td style='text-align:center;'>{v['n']}명</td>"
            f"<td style='text-align:center;'>{v['cart_rate']}%</td>"
            f"<td style='text-align:center;'>{v['chk_rate']}%</td>"
            f"<td style='text-align:center; font-weight:bold; color:#1a237e;'>{v['buy_rate']}%</td></tr>"
            for nm, v in sorted(bt.items(), key=lambda x: -x[1]['buy_rate']))
        funnel_html = f"""
<div class="page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">전환 퍼널 분석</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="summary-kpi-row">
      <div class="kpi-card blue"><div class="card-val">{cart_rate}%</div><div class="card-lbl">장바구니 단계 도달율</div></div>
      <div class="kpi-card orange"><div class="card-val">{chk_rate}%</div><div class="card-lbl">결제 단계 도달율</div></div>
      <div class="kpi-card green"><div class="card-val">{buy_rate}%</div><div class="card-lbl">구매 클릭 전환율</div></div>
    </div>

    <div class="section-block">
      <div class="section-title">단계별 도달율</div>
      <div class="chart-center"><img src="data:image/png;base64,{fchart}" style="max-width:160mm;"/></div>
    </div>

    <div class="section-block">
      <div class="section-title" style="margin-top:5mm;">가장 크게 새는 지점</div>
      <div class="insight-box">
        <div class="insight-label">진단</div>
        {leak_line}{leak_type_line}
      </div>
    </div>

    <div class="section-block">
    <div class="section-title" style="margin-top:5mm;">단계별 탐색 중지 상세</div>
    <table class="rec-table">
      <tr><th>탐색 중지 구간</th><th style="width:34mm; text-align:center;">탐색 중지 인원</th><th style="width:24mm; text-align:center;">탐색 중지율</th></tr>
      {drop_rows}
    </table>
    </div>

    <div class="section-block">
    <div class="section-title" style="margin-top:5mm;">고객 유형별 단계 도달율</div>
    <table class="rec-table">
      <tr><th>고객 유형</th><th style="text-align:center;">세션</th><th style="text-align:center;">장바구니</th><th style="text-align:center;">결제 도달</th><th style="text-align:center;">구매 클릭</th></tr>
      {bt_rows}
    </table>
    <div style="font-size:7.5pt; color:#90a4ae; margin-top:2mm;">
      ※ 구매 가능성 등급은 위 '구매 클릭' 도달율을 전체 평균({funnel['avg_buy']}%) 대비 상대 평가하여 산정합니다.
    </div>
    </div>
  </div>
</div>
"""

    # ── 상품 행동 데이터 페이지 ──────────────────────────────────────────────
    commerce = commerce or {}
    cc = commerce.get('counts', {})
    products = commerce.get('products', [])[:7]
    categories = commerce.get('categories', [])[:7]
    actions = commerce.get('recent_actions', [])[:8]

    def esc(value):
        return html_lib.escape(str(value or ''))

    product_rows = ''.join(
        f"<tr><td>{esc(item.get('name') or ('상품 ' + str(item.get('product_id', ''))))}</td>"
        f"<td class='num'>{item.get('clicks', 0)}</td><td class='num'>{item.get('detail_views', 0)}</td></tr>"
        for item in products
    ) or "<tr><td colspan='3'>확인된 상품 행동이 없습니다.</td></tr>"
    max_category_views = max((int(item.get('views', 0) or 0) for item in categories), default=1)
    category_rows = ''.join(
        f"<div class='category-row'><span>{esc(item.get('name') or '카테고리')}</span>"
        f"<span class='category-track'><span class='category-fill' style='display:block;width:{max(3, round(int(item.get('views', 0) or 0) / max_category_views * 100))}%'></span></span>"
        f"<span class='category-count'>{item.get('views', 0)}회</span></div>"
        for item in categories
    ) or "<div class='commerce-row'><span class='name'>확인된 카테고리가 없습니다.</span></div>"
    action_rows = ''.join(
        f"<div class='commerce-row'><span class='name'>{esc(item.get('label') or item.get('detail') or '상품 행동')}</span>"
        f"<span class='meta'>{esc(str(item.get('at') or '')[:10])}</span></div>"
        for item in actions
    ) or "<div class='commerce-row'><span class='name'>최근 상품 행동이 없습니다.</span></div>"

    note_parts = []
    if cc.get('cart_visits', 0) > 0 and cc.get('add_to_cart', 0) == 0:
        note_parts.append(f"장바구니 화면 방문 {cc.get('cart_visits', 0)}건은 확인됐지만 실제 담기 전용 이벤트는 없습니다.")
    if cc.get('checkout_starts', 0) > 0 and cc.get('order_completions', 0) == 0:
        note_parts.append(f"주문 진행 {cc.get('checkout_starts', 0)}건 이후 완료 신호가 없습니다.")
    tracking_note = ' '.join(note_parts) or '수집된 행동 신호를 기준으로 집계했으며 별도의 확인이 필요한 불일치는 없습니다.'

    commerce_html = f"""
<div class="page commerce-page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">상품 행동 데이터</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="summary-lead">
      <div class="eyebrow">ACTUAL COMMERCE EVENTS</div>
      <div class="headline">고객이 무엇을 보고 구매 흐름 어디까지 갔는지 확인합니다.</div>
      <div class="copy">상품·카테고리·후기 행동과 장바구니·주문 신호를 서로 구분해 집계했습니다. 페이지 HTML에 포함된 버튼 문구는 실제 행동으로 세지 않습니다.</div>
    </div>
    <div class="commerce-kpis">
      <div class="commerce-kpi"><div class="label">상품 클릭</div><div class="value">{cc.get('product_clicks', 0)}</div></div>
      <div class="commerce-kpi"><div class="label">리뷰 확인</div><div class="value">{cc.get('review_views', 0)}</div></div>
      <div class="commerce-kpi"><div class="label">카트 방문</div><div class="value">{cc.get('cart_visits', 0)}</div></div>
      <div class="commerce-kpi"><div class="label">장바구니 담기</div><div class="value">{cc.get('add_to_cart', 0)}</div></div>
      <div class="commerce-kpi"><div class="label">찜하기</div><div class="value">{cc.get('wishlist_adds', 0)}</div></div>
      <div class="commerce-kpi"><div class="label">주문 완료</div><div class="value">{cc.get('order_completions', 0)}</div></div>
    </div>
    <div class="commerce-cols">
      <div class="commerce-box"><h3>확인한 상품</h3>
        <table class="product-table"><tr><th>상품</th><th class="num">클릭</th><th class="num">상세</th></tr>{product_rows}</table>
      </div>
      <div class="commerce-box"><h3>확인한 카테고리</h3>{category_rows}</div>
    </div>
    <div class="commerce-cols recent-commerce" style="margin-top:5mm; grid-template-columns:1fr;">
      <div class="commerce-box"><h3>최근 상품 행동</h3>{action_rows}</div>
    </div>
    <div class="commerce-note"><b>행동 해석 참고</b> · {esc(tracking_note)}</div>
  </div>
</div>
"""

    # ── 탐색 중지 캡처 페이지 ────────────────────────────────────────────────
    exit_capture_page = ''
    if exit_captures:
        capture_cards = []
        for item in exit_captures:
            img = (
                f"<img src=\"data:image/png;base64,{item.get('capture_b64','')}\" "
                f"style=\"width:100%; border:1px solid #e0e0e0; border-radius:6px;\"/>"
                if item.get('capture_b64') else
                "<div style=\"height:52mm; border:1px dashed #cfd8dc; border-radius:6px; "
                "display:flex; align-items:center; justify-content:center; color:#78909c; font-size:8pt;\">"
                "캡처 생성 실패 - URL/섹션 정보만 표시</div>"
            )
            capture_cards.append(f"""
    <div style="break-inside:avoid; margin-bottom:5mm;">
      <div style="font-size:8.5pt; line-height:1.7; color:#37474f; margin-bottom:2mm;">
        <b>탐색 중지 {item.get('count', 0)}건</b>
        <span style="color:#90a4ae;">({item.get('share_pct', 0)}%)</span>
        · section <b>{item.get('section', 'unknown')}</b>
        · scrollY <b>{item.get('scroll_y', 0)}</b><br>
        <span style="color:#607d8b;">{item.get('url', '')}</span>
      </div>
      {img}
    </div>""")
        exit_capture_page = f"""
<div class="page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">탐색 중지 집중 화면 예시</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="insight-box" style="margin-bottom:5mm;">
      <div class="insight-label">캡처 기준</div>
      session_end/tab_exit/inactivity 이벤트를 page_url + section + scrollY 단위로 묶어 탐색 중지이 많은 화면을 캡처했습니다.
      빨간 가이드 라인은 해당 scrollY 기준으로 사용자가 머물다 탐색 중지한 구역을 나타냅니다.
    </div>
    {''.join(capture_cards)}
  </div>
</div>
"""

    cluster_pages = ''
    for cid in sorted(profiles.keys(), key=int):
        p      = profiles[cid]
        name   = type_name(cid, p)
        cnt    = p.get('count', 0)
        intt   = _intent[cid]
        ic     = INTENT_COLOR[intt]
        ibg    = INTENT_BG[intt]
        insight= ai_reports.get(cid, DUMMY_INSIGHT)
        share  = round(cnt / total_visits * 100) if total_visits else 0
        n_sub  = len(p.get('members', []))

        # ── 이름 근거 + 운영 의미 (서술형 아닌 데이터 근거) ──
        ft = funnel['by_type'].get(name) if funnel else None
        _pd = p.get('page_dist', {}); _allp = sum(_pd.values()) or 1
        _toppg = max(_pd, key=_pd.get) if _pd else None
        _ev = []
        if _toppg: _ev.append(f"{ko_page(_toppg)} 비중 {round(100*_pd[_toppg]/_allp)}%")
        _ev += [f"{ko_action(a['action'])} {a['count']}회" for a in meaningful_actions(p, 2)]
        if ft: _ev.append(f"구매클릭 도달율 {ft['buy_rate']}%·결제 도달율 {ft['chk_rate']}%")
        evidence = ' · '.join(_ev)
        MEANING = {
            '구매 결정형': '결제 직전 단계 방문 — 마지막 망설임만 제거하면 전환.',
            '가격 비교형': '가격 검토가 길어지는 비교 단계 — 가격 신뢰 신호가 관건.',
            '신중 탐색형': '정보 확인이 길어지는 중간 단계 — 후기·사이즈 정보가 결정 좌우.',
            '탐색 중지 위험형': '초기 탐색 중지 단계 — 재방문 유도와 진입 동선 점검 필요.',
            '상품 집중형': '특정 상품 심화 탐색 단계 — 추천·연관상품으로 결정 보조.',
            '비주얼 탐색형': '시각 정보 중심 탐색 단계 — 이미지·영상 강화가 효과적.',
            '홈 체류형': '상품 진입 전 초기 단계 — 진입 동선 단축이 우선.',
            '일반 탐색형': '구매 신호 약한 폭넓은 탐색 단계 — 관계 형성이 우선.',
        }
        meaning = MEANING.get(name, '행동 패턴에 맞춘 단계별 조치가 필요한 유형.')

        act_img  = chart_actions(cid, p)
        page_img = chart_pages(cid, p)

        # 주요 행동 상위 3개 텍스트 (특성 행동 우선)
        top3 = ' &nbsp;·&nbsp; '.join(
            f"{ko_action(a['action'])} {a['count']}회"
            for a in meaningful_actions(p, 3)
        )
        # 주요 페이지
        top_page = ', '.join(
            ko_page(k)
            for k, _ in sorted(p.get('page_dist', {}).items(), key=lambda x: -x[1])[:3]
        )

        cluster_pages += f"""
<div class="page cluster-page cluster-index-{cluster_idx}">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">고객 유형 상세 분석</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">

    <div class="manual-report-header">
      <div class="manual-top"><span>SEER ANALYTICS</span><span class="manual-period">{start} ~ {end}</span></div>
      <div class="manual-rule"></div><div class="manual-title">고객 유형 상세 분석</div>
    </div>

    <div class="type-header">
      <div class="embedded-report-header">
        <div class="embedded-report-top"><span class="embedded-brand">SEER ANALYTICS</span><span class="embedded-date">{start} ~ {end}</span></div>
        <div class="embedded-rule"></div><div class="embedded-title">고객 유형 상세 분석</div>
      </div>
      <div class="type-banner-main">
      <div>
        <div class="type-num">고객 유형</div>
        <div class="type-name">{name}</div>
        <div class="type-count">이번 주 방문 {cnt}건 · 전체의 {share}%{(' · 세부 패턴 ' + str(n_sub) + '개 통합') if n_sub > 1 else ''}</div>
      </div>
      <div class="intent-badge" style="background:{ibg}; color:{ic};">
        구매 가능성 {intt}
      </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-chip">📍 주요 페이지: <b>{top_page}</b></div>
      <div class="stat-chip">🔝 TOP 행동: <b>{top3}</b></div>
    </div>

    <div class="insight-box" style="margin-bottom:5mm;">
      <div class="insight-label">이 유형으로 분류한 근거</div>
      <b>근거:</b> {evidence}<br>
      <b>운영 의미:</b> {meaning}
    </div>

    <div class="section-title">행동 패턴 분석</div>
    <div class="charts-row">
      <div class="chart-box" style="flex: 1.6;">
        <img src="data:image/png;base64,{act_img}" style="width:100%;"/>
      </div>
      <div class="chart-box" style="flex: 1;">
        <img src="data:image/png;base64,{page_img}" style="width:100%;"/>
      </div>
    </div>

    <div class="section-title">AI 분석 인사이트</div>
    <div class="insight-box">
      <div class="insight-label">SEER 행동 분석 결과</div>
      {insight}
    </div>

  </div>
</div>
"""

    # ── 운영 제안 페이지 ──────────────────────────────────────────────────────
    recs_html = f"""
<div class="page recommendations-page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">운영 개선 제안</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="section-title">고객 유형별 추천 조치</div>
    <table class="rec-table">
      <tr>
        <th style="width:34mm;">고객 유형</th>
        <th style="width:20mm;">구매 가능성</th>
        <th>추천 운영 전략</th>
      </tr>
"""
    STRATEGY = {
        '구매 결정형': '결제 과정 간소화 및 신속 배송 강조. 쿠폰 즉시 지급으로 마무리 유도.',
        '가격 비교형': '가격 비교 배너 및 최저가 보장 문구 노출. 적립금·할인 혜택 강조.',
        '탐색 중지 위험형': '재방문 유도 푸시 알림, 장바구니 복귀 쿠폰 발송. 로딩 속도 점검.',
        '신중 탐색형': '상세 리뷰·사이즈 가이드 강화. 구매 후기 수 증가 이벤트 진행.',
        '비주얼 탐색형': '고품질 이미지 및 360° 뷰 제공. 스타일 코디 콘텐츠 추가.',
        '상품 집중형': '관련 상품 추천 기능 강화. 함께 구매한 상품 노출.',
        '홈 체류형': '홈 화면 기획전·배너 A/B 테스트. 관심 카테고리 맞춤 노출.',
        '일반 탐색형': '회원 가입 유도 팝업 및 첫 구매 혜택 강화.',
    }
    for cid in sorted(profiles.keys(), key=int):
        p    = profiles[cid]
        name = type_name(cid, p)
        intt = _intent[cid]
        _ft  = funnel['by_type'].get(name) if funnel else None
        _reason = (f"구매클릭 {_ft['buy_rate']}%·결제 {_ft['chk_rate']}% → " if _ft else '')
        strat= _reason + STRATEGY.get(name, '방문 행동 데이터 기반 맞춤 프로모션 기획 권장.')
        badge_cls = {'높음':'badge-high','중간':'badge-mid','낮음':'badge-low'}[intt]
        recs_html += f"""
      <tr>
        <td><b>{name}</b></td>
        <td><span class="{badge_cls}">{intt}</span></td>
        <td>{strat}</td>
      </tr>"""
    overall_text = html_lib.escape(overall_insight or (
        '구매 가능성이 높은 유형에는 결제 전환을 돕는 혜택을 우선 제공하고, '
        '탐색 중지 위험 유형에는 재방문 유도 메시지를 실험하세요. 다음 주에는 유형별 구매 단계 도달률 변화를 비교해 실행 결과를 확인하세요.'
    ))
    usage_text = html_lib.escape(usage_insight or (
        '고객 유형을 사이트 개인화와 재방문 메시지의 조건으로 활용하고, 각 실행 전후의 다음 단계 도달률을 비교하세요. '
        '표본이 작은 유형은 즉시 자동화하기보다 제한된 노출로 먼저 검증하는 것이 안전합니다.'
    ))
    recs_html += f"""
    </table>

    <div class="proposal-box">
      <div class="proposal-title" style="font-weight:bold; margin-bottom:3mm;">
        종합 제안
      </div>
      <div style="font-size:9pt; line-height:1.9; color:#37474f;">
        {overall_text}
      </div>
    </div>
    <div class="proposal-box usage">
      <div class="proposal-title" style="font-weight:bold; margin-bottom:3mm;">
        활용 제안
      </div>
      <div style="font-size:9pt; line-height:1.9; color:#37474f;">
        {usage_text}
      </div>
    </div>
  </div>
</div>
"""

    # ── 방법론 / 한계 / 다음 추적 지표 페이지 ─────────────────────────────────
    method_html = f"""
<div class="page method-page">
  <div class="page-header">
    <span class="brand">SEER</span>
    <span class="page-title">분석 방법 및 한계</span>
    <span class="period">{start} ~ {end}</span>
  </div>
  <div class="page-body">
    <div class="section-title">분석 기준</div>
    <table class="rec-table">
      <tr><th style="width:38mm;">항목</th><th>내용</th></tr>
      <tr><td><b>분석 단위</b></td><td>방문(세션) 기준 — 한 방문 동안의 행동 시퀀스를 1건으로 집계</td></tr>
      <tr><td><b>고객 유형 도출</b></td><td>세션 행동 시퀀스를 비지도 학습으로 임베딩 후 행동 패턴 군집화</td></tr>
      <tr><td><b>구매 가능성 산정</b></td><td>유형별 퍼널 하위 행동(장바구니→결제→구매 클릭) 도달율을 전체 평균 대비 상대 평가 (높음 ≥ 평균×1.2, 낮음 ≤ 평균×0.6)</td></tr>
      <tr><td><b>분석 표본</b></td><td>총 {total_visits:,}건 방문, {len(profiles)}개 고객 유형</td></tr>
    </table>

    <div class="section-title" style="margin-top:6mm;">분석의 한계</div>
    <div class="insight-box">
      · 실제 구매 완료·매출 데이터와 1:1 연결된 값이 아니라, <b>행동 패턴 기반 추정</b>입니다.<br>
      · 고객 유형은 정답 라벨이 없는 비지도 분류 결과로, 동일 유형 내에도 편차가 존재합니다.<br>
      · 제안된 조치는 운영 적용 전 <b>A/B 테스트로 효과 검증</b>을 권장합니다.
    </div>

    <div class="section-title" style="margin-top:6mm;">다음 달 추적 지표</div>
    <table class="rec-table">
      <tr><th>지표</th><th>성공 신호</th></tr>
      <tr><td>상품 상세 진입률</td><td>홈 체류·일반 탐색형 비중이 줄고 상품 진입이 늘면 개선</td></tr>
      <tr><td>장바구니 전환율</td><td>장바구니 단계 도달율 상승 시 탐색→고려 전환 개선</td></tr>
      <tr><td>구매 클릭 전환율</td><td>결제 도달 대비 구매 클릭 비율 상승 시 최종 전환 개선</td></tr>
    </table>
  </div>
</div>
"""

    # ── 최종 조합 ─────────────────────────────────────────────────────────────
    html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>{css}</style>
</head>
<body>
{cover_html}
{marketing_html}
{summary_html}
{summary_table_html}
{funnel_html}
{commerce_html}
{exit_capture_page}
{cluster_pages}
{recs_html}
{method_html}
</body>
</html>"""
    return html


# ── 리포트 생성 메인 ──────────────────────────────────────────────────────────
# 폰트 설정 → 데이터 로드 → AI 인사이트 → 퍼널 → 이탈캡처 → HTML·PDF 저장 순서로 실행한다
def site_key(origin: str) -> str:
    """origin을 파일명에 쓸 수 있는 형태로 바꾼다 (backend/routes/report.js의 siteKey와 동일 규칙)."""
    value = str(origin or '').strip().lower()
    value = re.sub(r'^https?://', '', value)
    return re.sub(r'[^a-z0-9._-]+', '_', value)


def generate_report(start_date: str, end_date: str, output_path: str,
                    origin: str = '', result_csv: str = '', metrics_json: str = '', commerce_json: str = ''):
    print("=" * 55)
    print("  SEER 고객 분석 리포트 생성기 (HTML → PDF)")
    print("=" * 55)
    if origin:
        print(f"  대상 사이트: {origin}")
    else:
        print("  ⚠️  대상 사이트 미지정 — 전체 사이트 데이터가 섞입니다.")
        print("      특정 쇼핑몰 리포트를 만들려면 --origin 을 지정하세요.")

    # 1. 폰트
    font_reg, font_bold = setup_fonts()

    # 2. 데이터 로드
    print("\n[1/4] 데이터 로드 중...")
    if result_csv:
        raw_profiles = load_result_csv(result_csv)
        profiles = merge_profiles(raw_profiles)
        print(f"  → 사이트별 result.csv 로드: {result_csv}")
    else:
        with open(META_PATH, encoding='utf-8') as f:
            meta = json.load(f)
        raw_profiles = meta.get('cluster_profiles', {})
        profiles = merge_profiles(raw_profiles)   # 12개 → 이름 기준 소수 유형으로 통합
    total_visits = sum(p.get('count', 0) for p in profiles.values()) or 1
    commerce = load_commerce_json(commerce_json)
    if commerce_json:
        print(f"  → 상품 행동 집계 로드: {commerce_json}")
    print(f"  → 원본 {len(raw_profiles)}개 클러스터 → {len(profiles)}개 고객 유형으로 통합")
    print(f"     총 {total_visits}건")

    # 3. AI 인사이트 (템플릿 기본 + Gemini 보강)
    print(f"\n[2/4] AI 인사이트 생성 중...")
    ai_reports = {}
    for cid in sorted(profiles.keys(), key=int):
        p     = profiles[cid]
        intt  = infer_intent(p)
        share = round(p.get('count', 0) / total_visits * 100)
        base  = template_insight(p['name'], p, intt, share)   # 항상 유형별로 다른 기본 문단
        if GEMINI_KEY:
            print(f"  {p['name']} 분석...", end=' ', flush=True)
            g = call_gemini(build_gemini_prompt(cid, p))
            # Gemini 성공 시 그 텍스트, 실패/오류 시 템플릿 사용
            ai_reports[cid] = g if (g and not g.startswith('(') and g != DUMMY_INSIGHT) else base
            print("완료")
            time.sleep(1.5)
        else:
            ai_reports[cid] = base

    # 유형별 문단과 별도로 리포트 전체를 가로지르는 종합·활용 제안을 생성한다.
    # 외부 AI를 사용할 수 없거나 응답이 실패하면 build_html의 데이터 기반 폴백을 쓴다.
    overall_insight = ''
    usage_insight = ''

    # 3.5 전환 퍼널 계산 (세션 단위 데이터)
    cid_to_name = {}
    for mp in profiles.values():
        for raw in mp.get('members', []):
            cid_to_name[str(raw)] = mp['name']
    # 마케팅 지표(metrics JSON)가 있으면 그 퍼널을 쓴다. 기존 compute_funnel은 전역 파일을
    # 읽고 origin을 걸러내지 않아 다른 쇼핑몰 세션이 섞일 수 있다.
    metrics = load_metrics(metrics_json) if metrics_json else None
    marketing_html = build_marketing_pages(metrics, start_date, end_date) if metrics else ''
    if marketing_html:
        print("  → 마케팅 지표 페이지 3쪽 구성 (기존 전역 퍼널은 사용하지 않음)")
        funnel = None
    else:
        funnel = compute_funnel(SESSION_SEQ_PATH, CLUSTER_RESULT_PATH, cid_to_name)
    if funnel:
        b = funnel['biggest']
        print(f"  → 퍼널: {funnel['total']}세션, 최대 누수 '{b[0]}' {b[1]}명({b[2]}%)")
    elif not marketing_html:
        print("  → 세션 데이터 없음 → 퍼널 페이지 생략")

    if GEMINI_KEY:
        print("  종합 제안 생성...", end=' ', flush=True)
        overall_candidate = call_gemini(build_overall_prompt(profiles, total_visits, funnel, commerce))
        if overall_candidate and not overall_candidate.startswith('(') and overall_candidate != DUMMY_INSIGHT:
            overall_insight = overall_candidate
        print("완료")
        time.sleep(1.0)
        print("  활용 제안 생성...", end=' ', flush=True)
        usage_candidate = call_gemini(build_usage_prompt(profiles, total_visits))
        if usage_candidate and not usage_candidate.startswith('(') and usage_candidate != DUMMY_INSIGHT:
            usage_insight = usage_candidate
        print("완료")

    print("\n[2.5/4] 탐색 중지 집중 화면 캡처 중...")
    # origin을 넘겨야 이 쇼핑몰 화면만 캡처된다 (안 넘기면 남의 사이트 화면이 섞임)
    exit_captures = capture_exit_hotspots(BASE_DIR, EXIT_CAPTURE_DIR, start_date, end_date,
                                          limit=3, origin=origin)
    if exit_captures:
        captured = sum(1 for x in exit_captures if x.get('capture_b64'))
        print(f"  → 탐색 중지 집중 구역 {len(exit_captures)}개 분석, 캡처 {captured}개 생성")
    else:
        print("  → 탐색 중지 집중 구역 없음 또는 캡처 생략")

    # 4. HTML 생성
    print("\n[3/4] HTML 리포트 구성 중...")
    host = (urlparse(origin).hostname or '').replace('www.', '')
    site_name = host.split('.')[0].capitalize() if host else '쇼핑몰'
    html = build_html(start_date, end_date, profiles, ai_reports, font_reg, font_bold, funnel, exit_captures,
                      marketing_html=marketing_html, commerce=commerce, site_name=site_name,
                      overall_insight=overall_insight, usage_insight=usage_insight)

    # HTML 파일도 저장 (디버깅용)
    html_path = output_path.replace('.pdf', '.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"  → HTML 저장: {html_path}")

    # 5. PDF 변환
    print("\n[4/4] PDF 변환 중...")
    try:
        from weasyprint import HTML as WH
        WH(filename=html_path).write_pdf(output_path)
    except (ModuleNotFoundError, OSError):
        browser = browser_executable()
        if not browser:
            print("  → WeasyPrint/Chrome 없음 → PDF 변환 생략, HTML만 생성")
            return
        # Chrome headless는 한글 경로 또는 사용 중인 기본 프로필에서 멈출 수 있다.
        # 영문 임시 경로와 전용 프로필에서 변환한 뒤 최종 위치로 이동한다.
        with tempfile.TemporaryDirectory(prefix='gt-report-', ignore_cleanup_errors=True) as temp_dir:
            temp_html = os.path.join(temp_dir, 'report.html')
            temp_pdf = os.path.join(temp_dir, 'report.pdf')
            profile_dir = os.path.join(temp_dir, 'chrome-profile')
            shutil.copyfile(html_path, temp_html)
            subprocess.run([
                browser,
                '--headless=new',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-sandbox',
                f'--user-data-dir={profile_dir}',
                f'--print-to-pdf={temp_pdf}',
                f'file:///{temp_html.replace(os.sep, "/")}',
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
            if not os.path.exists(temp_pdf):
                raise RuntimeError('Chrome PDF 변환 결과가 생성되지 않았습니다.')
            # Chrome 자식 프로세스가 Windows에서 임시 파일 핸들을 잠깐 유지할 수
            # 있으므로 파일 자체를 이동하지 않고 완성본을 별도로 복사한다.
            # 백엔드는 이 출력도 .generating 경로에 쓴 뒤 최종 이름으로 바꾼다.
            last_error = None
            for _ in range(20):
                try:
                    shutil.copyfile(temp_pdf, output_path)
                    last_error = None
                    break
                except PermissionError as exc:
                    last_error = exc
                    time.sleep(0.25)
            if last_error:
                raise last_error

    size_kb = os.path.getsize(output_path) // 1024
    total_p = 2 + len(profiles) + 1
    print("\n완료!")
    print(f"   PDF 출력: {output_path}")
    print(f"   파일 크기: {size_kb} KB  |  총 페이지: ~{total_p}p")


# CLI 인자(--start, --end, --output)를 파싱하고 generate_report를 호출한다
def main():
    p = argparse.ArgumentParser(description='SEER 리포트 생성')
    p.add_argument('--start',  default=datetime.now().strftime('%Y-%m-01'))
    p.add_argument('--end',    default=datetime.now().strftime('%Y-%m-%d'))
    p.add_argument('--output', default='')
    p.add_argument('--origin', default='',
                   help='대상 쇼핑몰 origin (예: https://toridos.cafe24.com). '
                        '지정하지 않으면 전체 사이트가 섞인다.')
    p.add_argument('--result-csv', default='',
                   help='사이트별 고객 유형 집계 CSV. 지정하면 전역 cluster_meta 대신 사용한다.')
    p.add_argument('--metrics-json', default='',
                   help='마케팅 지표 JSON(퍼널·채널·기기·시간대). 지정하면 마케팅 지표 4쪽을 앞에 넣는다.')
    p.add_argument('--commerce-json', default='',
                   help='사이트별 상품·장바구니·주문 행동 집계 JSON.')
    args = p.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    # 파일명에 사이트를 넣는다.
    # backend의 /api/report/weekly/download가 이 규칙으로 사이트별 파일을 찾는다.
    # 넣지 않으면 어느 쇼핑몰 운영자가 눌러도 같은 PDF가 내려간다.
    stamp = datetime.now().strftime('%Y%m%d')
    default_name = (f"ghosttracker_report_{site_key(args.origin)}_{stamp}.pdf"
                    if args.origin else f"ghosttracker_report_{stamp}.pdf")

    out = args.output or os.path.join(OUT_DIR, default_name)
    generate_report(args.start, args.end, out, origin=args.origin, result_csv=args.result_csv,
                    metrics_json=args.metrics_json, commerce_json=args.commerce_json)

if __name__ == '__main__':
    main()
