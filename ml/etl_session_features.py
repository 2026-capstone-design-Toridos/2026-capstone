"""
GhostTracker ETL Pipeline
Raw 이벤트 로그 (MongoDB) → 세션 단위 feature table (CSV)

사용법:
  1. .env 파일에 MONGODB_URI 설정
  2. pip install pymongo pandas python-dotenv
  3. python ml/etl_session_features.py
"""

import os
import pandas as pd
from pymongo import MongoClient
from dotenv import load_dotenv
from datetime import datetime

# ── 환경변수 로드 ────────────────────────────────────────────────
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '../backend/.env'))
MONGODB_URI = os.getenv('MONGODB_URI')

# ── MongoDB 연결 ─────────────────────────────────────────────────
def get_events(origin_filter=None, limit=50000):
    """MongoDB에서 raw 이벤트 로그 전체 조회"""
    client = MongoClient(MONGODB_URI)
    db = client['ghosttracker']
    collection = db['events']

    query = {}
    if origin_filter:
        query['origin'] = origin_filter

    cursor = collection.find(query).sort('timestamp', 1).limit(limit)
    events = list(cursor)
    client.close()

    print(f'[ETL] 이벤트 {len(events)}건 로드 완료')
    return events

# ── 세션 단위 feature 추출 ───────────────────────────────────────
def build_session_features(events):
    """
    이벤트 리스트 → 세션별 feature DataFrame

    추출 feature:
    [행동 기본]
      click_count          : 총 클릭 수
      dwell_time_sec       : 세션 체류 시간 (초)
      page_count           : 방문 페이지 수
      inter_event_gap_avg  : 평균 이벤트 간격 (ms)

    [마우스/스크롤]
      scroll_depth_max          : 최대 스크롤 깊이 (%)
      scroll_direction_change_count : 스크롤 방향 전환 횟수 (UX마찰/정보과부하)
      scroll_stop_count         : 스크롤 멈춤 횟수 (정보과부하)
      mouse_distance_total      : 총 마우스 이동 거리 (px)
      mouse_jitter_total        : 마우스 방향 전환 총 횟수 (UX마찰)
      hover_count               : hover dwell 발생 횟수
      hover_dwell_avg_ms        : 평균 hover 시간 (ms)

    [이탈 신호]
      tab_exit_count       : 탭 이탈 횟수
      rage_click_flag      : rage click 발생 여부 (0/1)
      bounce_flag          : 즉시 이탈 여부 (0/1)

    [입력/검색]
      search_count         : 검색 횟수
      search_length_avg    : 평균 검색어 길이
      input_abandon_count  : 입력 포기 횟수
      paste_count          : 붙여넣기 횟수

    [이커머스]
      product_click_count   : 상품 클릭 수
      add_to_cart_flag      : 장바구니 담기 여부 (0/1)
      add_to_cart_count     : 장바구니 담기 총 횟수
      remove_from_cart_count: 장바구니 삭제 횟수 (결정장애형)
      option_change_count   : 옵션 변경 횟수 (결정장애형)
      quantity_change_count : 수량 변경 횟수 (결정장애형)
      purchase_click_flag   : 구매 버튼 클릭 여부 (0/1)
      cart_abandon_flag     : 장바구니 담고 구매 안 함 (0/1)
      cart_indecision_flag  : 담기+삭제 동시 발생 여부 (0/1, 결정장애형)

    [미디어]
      image_slide_count    : 이미지 슬라이드 횟수
      video_play_flag      : 동영상 재생 여부 (0/1)

    [컨텍스트]
      device_type          : desktop / mobile / tablet
      utm_source           : 유입 경로
      origin               : 수집된 사이트

    [라벨 - 자동 생성]
      is_churned           : 이탈 여부 (장바구니/구매 없으면 1)
      is_bounce            : 즉시 이탈 (1페이지 + 30초 미만)
    """
    if not events:
        print('[ETL] 이벤트 없음')
        return pd.DataFrame()

    rows = []

    # session_id 기준으로 그룹화
    sessions = {}
    for e in events:
        sid = e.get('session_id')
        if not sid:
            continue
        if sid not in sessions:
            sessions[sid] = []
        sessions[sid].append(e)

    print(f'[ETL] 세션 수: {len(sessions)}')

    for sid, evs in sessions.items():
        evs_sorted = sorted(evs, key=lambda x: x.get('timestamp', 0))

        # ── 타입별 분류 ──────────────────────────────────────────
        def by_type(t):
            return [e for e in evs_sorted if e.get('event_type') == t]

        def data_val(e, key, default=0):
            return (e.get('data') or {}).get(key, default)

        # ── 기본 행동 ────────────────────────────────────────────
        clicks          = by_type('click')
        navigations     = by_type('navigation')
        timestamps      = [e.get('timestamp', 0) for e in evs_sorted if e.get('timestamp')]
        gaps            = [e.get('inter_event_gap', 0) for e in evs_sorted if e.get('inter_event_gap')]

        dwell_time_sec  = round((max(timestamps) - min(timestamps)) / 1000, 1) if len(timestamps) >= 2 else 0
        page_count      = len(navigations) or 1

        # ── 마우스/스크롤 ─────────────────────────────────────────
        scroll_events       = by_type('scroll_depth')
        scroll_dir_changes  = by_type('scroll_direction_change')
        scroll_stops        = by_type('scroll_stop')
        mouse_events        = by_type('mouse_move')
        hover_events        = by_type('hover_dwell')

        scroll_depths   = [data_val(e, 'depth_pct', 0) for e in scroll_events]
        mouse_distances = [data_val(e, 'distance_px', 0) for e in mouse_events]
        mouse_jitters   = [data_val(e, 'jitter_count', 0) for e in mouse_events]
        hover_times     = [data_val(e, 'hover_dwell_time_ms', 0) for e in hover_events]

        # ── 이탈 신호 ────────────────────────────────────────────
        tab_exits       = by_type('tab_exit')
        rage_clicks     = by_type('rage_click')

        # ── 입력/검색 ────────────────────────────────────────────
        searches        = by_type('search_use')
        input_abandons  = by_type('input_abandon')
        pastes          = by_type('paste_event')
        search_lengths  = [data_val(e, 'search_length', 0) for e in searches]

        # ── 이커머스 ─────────────────────────────────────────────
        product_clicks   = by_type('product_click')
        add_to_carts     = by_type('add_to_cart')
        remove_from_carts= by_type('remove_from_cart')
        purchase_clicks  = by_type('purchase_click')
        option_changes   = by_type('option_change')
        quantity_changes = by_type('quantity_change')

        has_cart        = len(add_to_carts) > 0
        has_purchase    = len(purchase_clicks) > 0

        # ── 미디어 ───────────────────────────────────────────────
        image_slides    = by_type('image_slide')
        video_plays     = by_type('video_play')

        # ── 컨텍스트 ─────────────────────────────────────────────
        first = evs_sorted[0]
        device_type = first.get('device_type', 'unknown')
        utm_source  = first.get('utm_source', 'direct') or 'direct'
        origin      = first.get('origin', '')

        # ── 라벨 자동 생성 ───────────────────────────────────────
        is_churned  = int(not has_cart and not has_purchase)
        is_bounce   = int(page_count <= 1 and dwell_time_sec < 30)

        rows.append({
            # ID
            'session_id':           sid,

            # 기본 행동
            'click_count':          len(clicks),
            'dwell_time_sec':       dwell_time_sec,
            'page_count':           page_count,
            'inter_event_gap_avg':  round(sum(gaps) / len(gaps), 1) if gaps else 0,

            # 마우스/스크롤
            'scroll_depth_max':          max(scroll_depths) if scroll_depths else 0,
            'scroll_direction_change_count': len(scroll_dir_changes),
            'scroll_stop_count':         len(scroll_stops),
            'mouse_distance_total':      round(sum(mouse_distances)),
            'mouse_jitter_total':        sum(mouse_jitters),
            'hover_count':               len(hover_events),
            'hover_dwell_avg_ms':        round(sum(hover_times) / len(hover_times)) if hover_times else 0,

            # 이탈 신호
            'tab_exit_count':       len(tab_exits),
            'rage_click_flag':      int(len(rage_clicks) > 0),
            'bounce_flag':          is_bounce,

            # 입력/검색
            'search_count':         len(searches),
            'search_length_avg':    round(sum(search_lengths) / len(search_lengths), 1) if search_lengths else 0,
            'input_abandon_count':  len(input_abandons),
            'paste_count':          len(pastes),

            # 이커머스
            'product_click_count':   len(product_clicks),
            'add_to_cart_flag':      int(has_cart),
            'add_to_cart_count':     len(add_to_carts),
            'remove_from_cart_count':len(remove_from_carts),
            'option_change_count':   len(option_changes),
            'quantity_change_count': len(quantity_changes),
            'purchase_click_flag':   int(has_purchase),
            'cart_abandon_flag':     int(has_cart and not has_purchase),
            # 결정장애 복합 신호: 담기/빼기 반복 여부
            'cart_indecision_flag':  int(len(add_to_carts) > 0 and len(remove_from_carts) > 0),

            # 미디어
            'image_slide_count':    len(image_slides),
            'video_play_flag':      int(len(video_plays) > 0),

            # 컨텍스트
            'device_type':          device_type,
            'utm_source':           utm_source,
            'origin':               origin,

            # 라벨
            'is_churned':           is_churned,
            'is_bounce':            is_bounce,
        })

    df = pd.DataFrame(rows)
    print(f'[ETL] feature table 생성 완료: {df.shape[0]}행 × {df.shape[1]}열')
    return df

# ── 저장 ─────────────────────────────────────────────────────────
def save(df, output_dir='ml/output'):
    os.makedirs(output_dir, exist_ok=True)
    today = datetime.now().strftime('%Y%m%d_%H%M')
    path  = os.path.join(output_dir, f'session_features_{today}.csv')
    df.to_csv(path, index=False)
    print(f'[ETL] 저장 완료 → {path}')
    return path

# ── 실행 ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('=== GhostTracker ETL 시작 ===')

    # origin 필터 없으면 전체, 특정 사이트만 원하면 아래 수정
    # origin_filter = 'https://jh-web-nu.vercel.app'
    events = get_events(origin_filter=None)

    if not events:
        print('[ETL] 데이터 없음. MongoDB에 이벤트가 수집됐는지 확인하세요.')
        exit(1)

    df = build_session_features(events)

    # 기본 통계 출력
    print('\n=== Feature Table 미리보기 ===')
    print(df.head(5).to_string())
    print('\n=== 라벨 분포 ===')
    print(f"  is_churned  1(이탈): {df['is_churned'].sum()}  /  0(전환): {(df['is_churned']==0).sum()}")
    print(f"  is_bounce   1(바운스): {df['is_bounce'].sum()}  /  0(일반): {(df['is_bounce']==0).sum()}")
    print(f"  add_to_cart 있음: {df['add_to_cart_flag'].sum()}")
    print(f"  purchase    있음: {df['purchase_click_flag'].sum()}")

    save(df)
    print('\n=== ETL 완료 ===')
