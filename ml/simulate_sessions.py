"""
GhostTracker 세션 시뮬레이터
============================
Playwright로 JH_Web 쇼핑몰에서 다양한 행동 패턴을 자동 시뮬레이션.
GhostTracker SDK가 삽입된 페이지에서 실제 이벤트가 MongoDB에 수집됨.

사용법:
  python ml/simulate_sessions.py              # 전체 패턴 각 3회씩
  python ml/simulate_sessions.py --sessions 5 # 패턴당 5회
  python ml/simulate_sessions.py --pattern bouncer  # 특정 패턴만

패턴:
  explorer  : 홈 → 상품 탐색 → 이미지 확대 → 스크롤
  bouncer   : 홈 보다가 바로 이탈
  buyer     : 홈 → 상품 → 장바구니 → 결제 클릭
  wanderer  : 탭 왔다갔다 + 비활성 반복
  reviewer  : 상품 → 리뷰 섹션 집중 탐색
  indecisive: 상품 → 장바구니 담기/빼기 반복
"""

import asyncio, random, argparse, time
from datetime import datetime
from playwright.async_api import async_playwright

SITES = {
    'JH': {
        'base':    'https://jh-web-nu.vercel.app',
        'product': 'https://jh-web-nu.vercel.app/products/1',
        'wait_sel': 'main',           # 페이지 준비 확인용
        'sel': {
            'product_card': 'a[href*="/products"], [class*="product"]',
            'product_img':  '[class*="product-detail"] img',
            'add_to_cart':  '[class*="product-detail__actions"] button',
            'buy_now':      '[class*="product-detail__actions"] button:last-child',
            'review':       '[class*="review"], [class*="rating"]',
        },
    },
    'DM': {
        'base':    'https://toridos.vercel.app',
        'product': 'https://toridos.vercel.app',
        'sel': {
            'product_card': '[class*="product"], [class*="item"], [class*="card"]',
            'product_img':  'img',
            'add_to_cart':  '[class*="cart"], [class*="add"]',
            'buy_now':      '[class*="buy"], [class*="purchase"], [class*="order"]',
            'review':       '[class*="review"], [class*="rating"]',
        },
    },
    'SY': {
        'base':    'https://sy-web.vercel.app',
        'product': 'https://sy-web.vercel.app/product/prod_1',
        'sel': {
            'product_card': '[class*="product"], [class*="item"], [class*="card"]',
            'product_img':  'img',
            'add_to_cart':  '[class*="cart"], [class*="add"]',
            'buy_now':      '[class*="buy"], [class*="purchase"], [class*="order"]',
            'review':       '[class*="review"], [class*="rating"]',
        },
    },
}

WAIT_SDK     = 3000   # SDK 초기화 대기 (ms)
WAIT_EVENT   = 800    # 이벤트 수집 대기 (ms)


# ── 공통 헬퍼 ────────────────────────────────────────────────────────

async def slow_scroll(page, steps=6, direction='down', delay_ms=400):
    """JS scrollBy로 실제 scroll 이벤트 발생"""
    for _ in range(steps):
        delta = random.randint(150, 350) * (1 if direction == 'down' else -1)
        await page.evaluate(f"window.scrollBy({{top: {delta}, behavior: 'smooth'}})")
        await page.wait_for_timeout(delay_ms + random.randint(0, 200))

async def hover_elements(page, selector, count=3, dwell_ms=600):
    """실제 마우스 이동으로 hover — SDK mouseover 리스너에 정확히 전달됨"""
    try:
        els = await page.query_selector_all(selector)
        if not els:
            print(f'    [hover] 요소 없음: {selector[:60]}')
            return 0
        targets = random.sample(els, min(count, len(els)))
        success = 0
        for el in targets:
            try:
                await el.scroll_into_view_if_needed()
                box = await el.bounding_box()
                if not box:
                    continue
                cx = box['x'] + box['width'] / 2
                cy = box['y'] + box['height'] / 2
                await page.mouse.move(cx, cy)
                await page.wait_for_timeout(dwell_ms + random.randint(0, 400))
                # 마우스를 살짝 이동해서 mouseleave 유도
                await page.mouse.move(cx + 30, cy + 30)
                success += 1
            except Exception:
                pass
        print(f'    [hover] {success}/{len(targets)} 성공')
        return success
    except Exception as e:
        print(f'    [hover] 오류: {e}')
        return 0

async def click_random(page, selector, label=''):
    """실제 마우스 클릭 — SDK click 리스너에 정확히 전달됨"""
    try:
        els = await page.query_selector_all(selector)
        if not els:
            print(f'    [click] 요소 없음: {label or selector[:60]}')
            return False
        el = random.choice(els)
        await el.scroll_into_view_if_needed()
        box = await el.bounding_box()
        if not box:
            print(f'    [click] bounding_box 없음: {label}')
            return False
        cx = box['x'] + box['width'] / 2
        cy = box['y'] + box['height'] / 2
        await page.mouse.click(cx, cy)
        await page.wait_for_timeout(WAIT_EVENT)
        print(f'    [click] 성공: {label or selector[:40]}')
        return True
    except Exception as e:
        print(f'    [click] 실패: {label} — {e}')
        return False

async def simulate_tab_switch(page, count=2, away_ms=3000):
    """탭 이탈 시뮬레이션 — document.hidden 값도 실제로 변경"""
    for i in range(count):
        # 탭 숨김: hidden=true, visibilityState='hidden'
        await page.evaluate("""() => {
            Object.defineProperty(document, 'hidden',
                { value: true, configurable: true });
            Object.defineProperty(document, 'visibilityState',
                { value: 'hidden', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        print(f'    [tab] 이탈 {i+1}회')
        await page.wait_for_timeout(away_ms + random.randint(0, 2000))

        # 탭 복귀: hidden=false, visibilityState='visible'
        await page.evaluate("""() => {
            Object.defineProperty(document, 'hidden',
                { value: false, configurable: true });
            Object.defineProperty(document, 'visibilityState',
                { value: 'visible', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        print(f'    [tab] 복귀 {i+1}회')
        await page.wait_for_timeout(1000)

async def wait_inactivity(page, ms=5000):
    """비활성 상태 시뮬레이션"""
    await page.wait_for_timeout(ms + random.randint(0, 2000))


# ── 행동 패턴 ────────────────────────────────────────────────────────

async def pattern_explorer(page, site):
    """홈 → 상품 탐색 → 이미지 확대 → 스크롤"""
    sel = site['sel']
    await page.goto(site['base'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=4)
    await hover_elements(page, sel['product_card'], count=3)
    await page.wait_for_timeout(1000)

    await page.goto(site['product'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=5)
    await hover_elements(page, sel['product_img'], count=4, dwell_ms=800)
    await click_random(page, sel['product_img'], label='product_img')
    await page.wait_for_timeout(1500)
    await slow_scroll(page, steps=3, direction='up')
    await page.wait_for_timeout(2000)


async def pattern_bouncer(page, site):
    """홈 진입 후 1~3초 내 클릭/스크롤 없이 즉시 이탈 (진짜 bounce)"""
    await page.goto(site['base'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)
    await page.wait_for_timeout(random.randint(1000, 3000))


async def pattern_buyer(page, site):
    """홈 → 상품 → 장바구니 → 구매 클릭"""
    sel = site['sel']
    wait_sel = site.get('wait_sel', 'body')

    await page.goto(site['base'], wait_until='load')
    await page.wait_for_selector(wait_sel, timeout=10000)
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=3)
    await hover_elements(page, sel['product_card'], count=2)

    await page.goto(site['product'], wait_until='load')
    await page.wait_for_selector(wait_sel, timeout=10000)
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=4)
    await hover_elements(page, sel['product_img'], count=3, dwell_ms=1000)
    await page.wait_for_timeout(1500)

    await click_random(page, sel['add_to_cart'], label='add_to_cart')
    await page.wait_for_timeout(2000)
    await click_random(page, sel['buy_now'], label='buy_now')
    await page.wait_for_timeout(2000)


async def pattern_wanderer(page, site):
    """탭 이탈/복귀 + 비활성 반복"""
    sel = site['sel']
    await page.goto(site['base'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await simulate_tab_switch(page, count=1, away_ms=4000)
    await slow_scroll(page, steps=2)

    await page.goto(site['product'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=3)
    await wait_inactivity(page, ms=6000)
    await simulate_tab_switch(page, count=2, away_ms=3000)
    await hover_elements(page, sel['product_img'], count=2)
    await wait_inactivity(page, ms=4000)


async def pattern_reviewer(page, site):
    """상품 → 리뷰 섹션 집중 탐색"""
    sel = site['sel']
    await page.goto(site['product'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=8, delay_ms=300)
    await hover_elements(page, sel['review'], count=4, dwell_ms=1200)
    await click_random(page, sel['review'], label='review')
    await page.wait_for_timeout(2000)
    await slow_scroll(page, steps=3, direction='up')
    await slow_scroll(page, steps=3, direction='down')
    await page.wait_for_timeout(2000)


async def pattern_indecisive(page, site):
    """상품 → 장바구니 담기/빼기 반복 (결정장애형)"""
    sel = site['sel']
    await page.goto(site['product'], wait_until='load')
    await page.wait_for_timeout(WAIT_SDK)

    await slow_scroll(page, steps=4)
    await hover_elements(page, sel['product_img'], count=3, dwell_ms=1000)

    for _ in range(random.randint(2, 4)):
        await click_random(page, sel['add_to_cart'], label='add_to_cart')
        await page.wait_for_timeout(1500)

    await wait_inactivity(page, ms=3000)
    await simulate_tab_switch(page, count=1, away_ms=3000)
    await page.wait_for_timeout(2000)


PATTERNS = {
    'explorer':   pattern_explorer,
    'bouncer':    pattern_bouncer,
    'buyer':      pattern_buyer,
    'wanderer':   pattern_wanderer,
    'reviewer':   pattern_reviewer,
    'indecisive': pattern_indecisive,
}


# ── 실행 엔진 ────────────────────────────────────────────────────────

async def run_session(playwright, pattern_name: str, site_name: str, idx: int, headless: bool):
    pattern_fn = PATTERNS[pattern_name]
    site = SITES[site_name]

    browser = await playwright.chromium.launch(headless=headless)
    context = await browser.new_context(
        viewport={'width': random.choice([1280, 1440, 1920]),
                  'height': random.choice([720, 800, 900])},
        user_agent=(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        )
    )
    page = await context.new_page()

    try:
        print(f'  [{idx+1}] [{site_name}] {pattern_name} 시작...')
        await pattern_fn(page, site)
        await page.wait_for_timeout(3000)
        print(f'  [{idx+1}] [{site_name}] {pattern_name} 완료 ✅')
    except Exception as e:
        print(f'  [{idx+1}] [{site_name}] {pattern_name} 오류: {e}')
    finally:
        await browser.close()


async def main(args):
    site_names = args.site.split(',') if args.site else list(SITES.keys())
    # 유효성 검사
    for s in site_names:
        if s not in SITES:
            print(f'[오류] 알 수 없는 사이트: {s}  (가능: {list(SITES.keys())})')
            return

    # (site, pattern) 조합 생성
    combos = [
        (site, pattern)
        for site in site_names
        for pattern in ([args.pattern] if args.pattern else list(PATTERNS.keys()))
        for _ in range(args.sessions)
    ]
    random.shuffle(combos)

    total = len(combos)
    print(f'=== GhostTracker 세션 시뮬레이터 ===')
    print(f'대상 사이트: {site_names}')
    print(f'총 {total}세션 실행 예정  (headless={not args.show})\n')

    async with async_playwright() as pw:
        for i, (site, pattern) in enumerate(combos):
            await run_session(pw, pattern, site, i, headless=not args.show)
            await asyncio.sleep(random.uniform(2, 4))

    print(f'\n=== 완료: {total}세션 수집 ===')
    print(f'MongoDB 반영 확인 후 파이프라인 재실행하세요.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='GhostTracker 세션 시뮬레이터')
    parser.add_argument('--sessions', type=int, default=3,
                        help='패턴당 실행 횟수 (기본 3)')
    parser.add_argument('--pattern', default=None,
                        choices=list(PATTERNS.keys()),
                        help='특정 패턴만 실행')
    parser.add_argument('--site', default=None,
                        help='사이트 선택: JH, DM, SY 또는 콤마 구분 (기본: 전체)')
    parser.add_argument('--show', action='store_true',
                        help='브라우저 화면 표시 (headless 해제)')
    args = parser.parse_args()
    asyncio.run(main(args))
