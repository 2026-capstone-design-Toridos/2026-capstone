# 2026-capstone
GostTracker: 소상공인을 위한 데이터 마케팅 도우미

---

## ✅ Team
<table>
  <tr>
    <td align="center">
      <a href="https://github.com/kdm0927">
        <img src="https://github.com/kdm0927.png" width="100px;" alt="김다민 프로필"/>
        <br />
        <sub><b>김다민</b><br />Product Owner</sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/joehyun000">
        <img src="https://github.com/joehyun000.png" width="100px;" alt="박조현 프로필"/>
        <br />
        <sub><b>박조현</b><br />Scrum Master</sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/suyeonb">
        <img src="https://github.com/suyeonb.png" width="100px;" alt="배수연 프로필"/>
        <br />
        <sub><b>배수연</b><br />Tech Info Manager</sub>
      </a>
    </td>
  </tr>
</table>

---

## ✅ 배경
- 자사몰의 '데이터 사각지대' 해결  
- GA4(구글 애널리틱스)의 한계와 틈새 시장
- '분석 도구'에서 'AI 컨설턴트'로의 전환
- D2C 마켓의 급성장과 개별 브랜드 자사몰 확산

---

## ✅ 목표
1. [데이터 가치 목표] 비회원 고객 위주의 행동 로그 기반 '이탈 원인' 심층 규명
2. [사용자 경험 목표] 비전문가용 '자연어 기반 이탈 방지 인사이트' 제공
3. [운영 효율 목표] '코드 한 줄'로 시작하는 자동화된 데이터 분석 환경 구축

---

## ✅ 기능
1. 제로-컨피그(Zero-Config) 행동 수집 SDK
2. 세션 기반 데이터 피처링(Feature Engineering)
3. 소규모 데이터 특화 이탈 예측 모델
4. 설명 가능한 AI(XAI) 원인 진단
5. 자연어 기반 UX 컨설팅 리포트 (대시보드)

---

## 📎 Links
[![Notion](https://img.shields.io/badge/Notion-%23000000.svg?style=for-the-badge&logo=notion&logoColor=white)](https://www.notion.so/Toridos-265f0c1d63f280a0a66cd0457f8280f7?source=copy_link)

---

---

# GhostTracker SDK — 팀원 연동 가이드

> **A파트 담당: 박조현**  
> SDK 삽입 및 테스트 방법을 단계별로 설명합니다.

---

## 전체 흐름

```
여러분의 쇼핑몰 (HTML/React)
        ↓  사용자 행동 감지
   GhostTracker SDK  (sdk-A / sdk-B / sdk-C)
        ↓  POST /collect
   DM_Web 백엔드  →  대시보드 실시간 표시  →  AI 분석
```

---

## 1단계 — SDK 파일 복사

프로젝트의 정적 파일 폴더에 `ghost-tracker/` 디렉토리를 만들고 아래 파일을 복사합니다.

```
your-project/
└── public/
    └── ghost-tracker/
        ├── index.js        ← 진입점 (이것만 <script> 태그로 로드)
        ├── sdk-A.js
        ├── sdk-B.js
        ├── sdk-C.js
        └── core/
            ├── eventProcessor.js
            ├── sender.js
            ├── sessionManager.js
            └── timeTracker.js
```

**파일 출처:** 이 레포지토리의 루트에 있는 파일들을 그대로 복사하면 됩니다.

---

## 2단계 — 스크립트 태그 삽입

`public/index.html` (또는 `<head>` 태그가 있는 HTML 파일)에 아래 한 줄을 추가합니다.

```html
<head>
  ...
  <!-- GhostTracker SDK -->
  <script type="module" src="/ghost-tracker/index.js"></script>
</head>
```

> **React(CRA) 프로젝트라면** `%PUBLIC_URL%` prefix 사용:
> ```html
> <script type="module" src="%PUBLIC_URL%/ghost-tracker/index.js"></script>
> ```

---

## 3단계 — HTML에 data 속성 추가

SDK-C가 이커머스 이벤트를 자동 감지하려면 주요 요소에 아래 속성을 달아야 합니다.  
**속성이 없으면 해당 이벤트는 수집되지 않습니다.**

### 3-1. 섹션 추적 (`data-section`)

사용자가 어느 영역을 봤는지 추적합니다. 주요 `<section>`, `<div>` 등에 추가하세요.

```html
<section data-section="hero">          <!-- 메인 배너 -->
<section data-section="product-list">  <!-- 상품 목록 -->
<div     data-section="product-detail"><!-- 상품 상세 -->
<div     data-section="cart">          <!-- 장바구니 -->
<div     data-section="checkout">      <!-- 결제 페이지 -->
```

### 3-2. 서브섹션 추적 (`data-subsection`)

섹션 안의 세부 영역을 추적합니다.

```html
<div data-subsection="product-images"> <!-- 상품 이미지 -->
<div data-subsection="product-info">   <!-- 상품 정보 -->
<div data-subsection="product-reviews"><!-- 리뷰 영역 -->
```

### 3-3. 이커머스 버튼 (`data-ghost-role` + `data-product-id`)

| `data-ghost-role` 값 | 수집 이벤트 | 적용 대상 |
|---|---|---|
| `product-card` | `product_click` | 상품 카드 클릭 영역 |
| `add-to-cart` | `add_to_cart` | 장바구니 담기 버튼 |
| `purchase-btn` | `purchase_click` | 결제하기 버튼 |
| `remove-from-cart` | `remove_from_cart` | 장바구니 삭제 버튼 |
| `option-select` | `option_select` | 사이즈/색상 select 태그 |

```html
<!-- 상품 카드 -->
<div data-ghost-role="product-card"
     data-product-id="42"
     data-product-name="로맨틱 원피스">
  ...
</div>

<!-- 장바구니 담기 버튼 -->
<button data-ghost-role="add-to-cart"
        data-product-id="42"
        data-product-name="로맨틱 원피스">
  장바구니 담기
</button>

<!-- 결제 버튼 -->
<button data-ghost-role="purchase-btn">
  결제하기
</button>

<!-- 삭제 버튼 -->
<button data-ghost-role="remove-from-cart"
        data-product-id="42">✕</button>

<!-- 옵션 select (사이즈, 색상 등) -->
<select data-ghost-role="option-select"
        data-product-id="42"
        name="size">
  <option>S</option>
  <option>M</option>
</select>
```

> **React JSX라면** `data-product-id={product.id}` 형태로 동적 값도 사용 가능합니다.

---

## 4단계 — 테스트 확인 방법

### 방법 A: 콘솔 로그로 확인 (빠른 확인)

사이트를 열고 **개발자도구(F12) → Console** 탭을 엽니다.

SDK가 정상 로드되면 아래 로그가 보입니다:
```
[GhostTracker] sdk-B initialized
[GhostTracker] sdk-C initialized
```

이후 클릭, 스크롤, 상품 클릭 등 행동을 하면:
```
[GhostTracker] click         {session_id: "abc123", event_seq: 1, event_token: 10, ...}
[GhostTracker] section_enter {section: "product-list", event_seq: 2, ...}
[GhostTracker] product_click {product_id: "42", event_seq: 3, ...}
[GhostTracker] add_to_cart   {product_id: "42", quantity: 1, event_seq: 4, ...}
```

> 콘솔 필터창에 `GhostTracker` 검색하면 SDK 로그만 모아서 볼 수 있습니다.

### 방법 B: 이벤트 보기 좋게 출력 (JS 붙여넣기)

콘솔에 아래 코드를 붙여넣으면 이벤트 발생 시 컬러로 출력됩니다:

```js
const _orig = console.debug.bind(console);
console.debug = function(...args) {
  if (args[0] === '[GhostTracker]') {
    console.log('%c📡 ' + args[1], 'color:#6c63ff;font-weight:bold', args[2]);
  }
  _orig(...args);
};
```

---

## 5단계 — 백엔드 연결 (DM_Web 준비되면)

현재 `sender.js`의 `COLLECT_URL`이 비어있어 이벤트가 전송되지 않습니다.  
DM_Web 백엔드 URL이 확정되면 아래 파일 한 줄만 수정하면 됩니다:

```js
// ghost-tracker/core/sender.js  (1번째 줄)
const COLLECT_URL = 'https://[DM_Web_배포_URL]/collect';
```

---

## 수집되는 이벤트 전체 목록

| 카테고리 | 이벤트명 | 설명 |
|---|---|---|
| 세션 | `session_start` / `session_end` | 세션 시작/종료 |
| 페이지 | `navigation` | SPA 페이지 이동 |
| 클릭 | `click` / `rage_click` | 클릭, 연속 클릭 |
| 마우스 | `mouse_move` / `hover_dwell` | 마우스 이동, 요소 hover |
| 탭 | `tab_exit` / `tab_return` | 탭 이탈/복귀 |
| 폼 | `input_change` / `field_blur` / `input_abandon` / `search_use` | 입력 행동 |
| 스크롤 | `scroll_depth` / `scroll_milestone` / `scroll_direction_change` | 스크롤 행동 |
| 섹션 | `section_enter` / `section_exit` / `section_revisit` | 섹션 진입/이탈/재방문 |
| 이커머스 | `product_click` / `add_to_cart` / `remove_from_cart` / `purchase_click` | 구매 행동 |
| 이커머스 | `option_select` / `option_change` / `quantity_change` | 옵션 선택 |
| 이커머스 | `cart_abandon_flag` | 장바구니 담고 이탈 |
| 비활성 | `inactivity` | 일정 시간 이상 비활성 |
| 파생 | `time_to_first_click` | 세션 시작 후 첫 클릭까지 시간 |

---

## 참고: 자동 수집 필드 (모든 이벤트 공통)

data 속성 없이도 SDK가 **자동으로** 모든 이벤트에 아래 필드를 붙입니다:

```json
{
  "session_id":      "uuid-자동생성",
  "event_type":      "click",
  "event_seq":       3,
  "event_token":     10,
  "inter_event_gap": 1200,
  "timestamp":       1712500000000,
  "page_url":        "https://your-shop.vercel.app/products/42",
  "pathname":        "/products/42",
  "referrer":        "https://your-shop.vercel.app/products",
  "device_type":     "desktop",
  "data": { ... }
}
```

---

## 문의

A파트 담당 **박조현** 에게 연락주세요.
