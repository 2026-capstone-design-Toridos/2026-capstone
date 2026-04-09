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
> 파일 다운로드 없음. 아래 순서대로만 따라하면 됩니다.

---

## STEP 1 — script 태그 한 줄 추가

자기 쇼핑몰 프로젝트에서 `public/index.html` 파일을 열고,  
`</head>` 바로 위에 아래 한 줄을 붙여넣으세요.

```html
<script src="https://two026-capstone.onrender.com/gt.js"></script>
```

**어디에 넣는지 예시:**
```html
<head>
  <meta charset="UTF-8" />
  <title>내 쇼핑몰</title>

  <!-- 여기에 붙여넣기 -->
  <script src="https://two026-capstone.onrender.com/gt.js"></script>
</head>
<body>
  ...
```

> 이것만 해도 클릭, 스크롤, 세션, 마우스 이동 등 기본 이벤트는 **자동으로 전부 수집**됩니다.

---

## STEP 2 — 잘 됐는지 확인

사이트를 열고 **F12 → Console 탭** 클릭.  
아래 두 줄이 보이면 성공입니다.

```
[GhostTracker] sdk-B initialized
[GhostTracker] sdk-C initialized
```

그 상태에서 화면을 클릭하거나 스크롤하면 이런 로그가 실시간으로 찍힙니다:

```
[GhostTracker] click         {session_id: "a3f...", event_seq: 1, ...}
[GhostTracker] scroll_depth  {session_id: "a3f...", event_seq: 2, ...}
```

---

## STEP 3 — 대시보드에서 실시간 확인

아래 링크를 열면 모든 쇼핑몰에서 수집된 이벤트를 실시간으로 볼 수 있습니다.

👉 **https://two026-capstone.onrender.com/dashboard.html**

---

## STEP 4 — (선택) 이커머스 이벤트 추가 수집

상품 클릭, 장바구니 담기, 결제 등을 추적하려면  
해당 HTML 요소에 `data-ghost-role` 속성을 추가합니다.

### 상품 카드 (누르면 product_click 이벤트 수집)

```html
<!-- 클릭 가능한 상품 카드 div나 a 태그에 추가 -->
<div data-ghost-role="product-card"
     data-product-id="상품ID"
     data-product-name="상품이름">
  ...
</div>
```

### 장바구니 담기 버튼

```html
<button data-ghost-role="add-to-cart"
        data-product-id="상품ID"
        data-product-name="상품이름">
  장바구니 담기
</button>
```

### 결제하기 버튼

```html
<button data-ghost-role="purchase-btn">
  결제하기
</button>
```

### 장바구니 삭제 버튼

```html
<button data-ghost-role="remove-from-cart"
        data-product-id="상품ID">
  삭제
</button>
```

### 사이즈/색상 선택 (select 태그만 해당)

```html
<select data-ghost-role="option-select"
        data-product-id="상품ID"
        name="size">
  <option>S</option>
  <option>M</option>
  <option>L</option>
</select>
```

> **React(JSX) 프로젝트라면** `data-product-id={product.id}` 처럼 동적 값 사용 가능합니다.

---

## 자동으로 수집되는 이벤트 목록

script 태그 한 줄만 넣어도 아래 이벤트는 **자동 수집**됩니다.

| 이벤트 | 설명 |
|---|---|
| `session_start` / `session_end` | 방문 시작 / 종료 |
| `click` | 모든 클릭 |
| `rage_click` | 같은 곳을 연속으로 클릭 (답답함 감지) |
| `scroll_depth` | 페이지 몇 % 스크롤했는지 |
| `scroll_milestone` | 25%, 50%, 75%, 100% 도달 |
| `scroll_direction_change` | 스크롤 방향 바뀔 때 |
| `mouse_move` | 마우스 이동 경로 |
| `hover_dwell` | 특정 요소에 300ms 이상 머물 때 |
| `tab_exit` / `tab_return` | 다른 탭으로 갔다가 돌아올 때 |
| `input_change` | 입력창 타이핑 |
| `input_abandon` | 입력 중 포기 |
| `search_use` | 검색어 입력 |
| `inactivity` | 일정 시간 움직임 없음 |
| `time_to_first_click` | 페이지 열고 첫 클릭까지 걸린 시간 |
| `navigation` | 페이지 이동 (SPA) |

---

## 문의

A파트 담당 **박조현** 에게 연락주세요.
