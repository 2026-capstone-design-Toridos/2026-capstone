# GhostTracker 구현 명세서

> 작성일: 2026-07-30
> 대상 저장소: `2026-capstone-design-Toridos/2026-capstone` (main 기준)
> 테스트 환경: https://toridos.cafe24.com

---

## 0. 이 문서를 읽는 법

이 문서는 **"지금 코드에서 무엇이 안 되고 있고, 왜 고쳐야 하며, 어떤 파일을 건드릴 것인가"**를 정리한 작업 명세입니다.

- **1~3단계**는 바로 착수할 작업이라 구현 수준까지 적었습니다.
- **4~6단계**는 앞 단계 결과에 따라 세부가 바뀌므로 방향과 범위만 적었습니다.
- 각 단계 끝에 **완료 기준**이 있습니다. 이 기준을 못 채우면 다음 단계로 넘어가지 않습니다.
- 모든 주장에는 `파일:줄번호` 또는 실측 데이터 근거를 붙였습니다. 부록 A에 실측 원본이 있습니다.

---

## 1. 왜 이 작업이 필요한가 — 현재 상태 요약

한 문장으로: **SDK는 이벤트를 수집하고 있지만, 그 이벤트에 "쇼핑몰에서 무슨 일이 있었는지"라는 의미가 붙지 않습니다.**

클릭 좌표와 스크롤 깊이는 쌓이는데, "어떤 상품을 봤는지", "옵션을 몇 번 바꿨는지", "장바구니에 담았는지", "주문에 성공했는지"가 비어 있습니다. 그 상태로 클러스터링을 돌리면 페르소나가 갈리지 않습니다. 지금 "클러스터링이 잘 안 되는" 현상의 원인이 모델이 아니라 **입력 데이터**에 있다는 것이 이 문서의 핵심 진단입니다.

문제는 세 층위로 나뉩니다.

| 층위 | 증상 | 해당 단계 |
|---|---|---|
| **수집 신뢰성** | 세션이 1분마다 끊기고, 전송 실패 시 데이터가 사라짐 | 1단계 |
| **의미 부여** | 상품·옵션·장바구니·주문성공을 인식하지 못함 | 2·3·4단계 |
| **활용** | 대시보드 수치가 부정확하고, 클러스터 결과가 휘발됨 | 5·6단계 |

아래 순서는 이 의존 관계를 따릅니다. **수집이 깨진 상태에서 모은 데이터로는 이후 단계를 검증할 수 없기 때문에** 순서를 바꾸면 작업을 두 번 하게 됩니다.

---

## 2. 전체 로드맵

| 단계 | 작업 | 왜 이 순서인가 | 상태 |
|---|---|---|---|
| 0 | 배포 환경 실측 | 6단계 설계가 이 결과에 달림 | 진행 중 (팀 확인 대기) |
| 1 | SDK 안정화 | 이게 안 되면 이후 수집 데이터 전부 폐기 | 착수 대기 |
| 2 | 유입 경로 추적 | SDK 수정이라 1과 같이 배포해야 배포 횟수가 줌 | 착수 대기 |
| 3 | Cafe24 어댑터 | 1·2가 끝나야 붙일 수 있음 | 착수 대기 |
| 4 | 페이지 이벤트 매핑 | 3의 어댑터 출력에 의존 | 대기 |
| 5 | 대시보드 고도화 | 4의 페이지 타입에 의존 | 대기 |
| 6 | 클러스터링 저장 구조 | 데이터가 쌓인 뒤 검증 가능 | 대기 |

---

# 0단계 — 배포 환경 실측

## 왜 하는가

`backend/routes/clusters.js:19`, `backend/routes/classify.js:23`

```js
const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';
```

Python 분류 서버 주소가 **기본값 `localhost:5002`**입니다. Render에 배포된 Node 서버 입장에서 `localhost`는 자기 자신이고, 거기엔 Python 서버가 없습니다.

`CLUSTER_SERVER_URL` 환경변수가 안 잡혀 있다면 배포 환경에서 다음이 **전부 실패**합니다.

- 운영자 대시보드 "이 고객 분석" 버튼 (`/api/classify/session/:id`)
- 운영자 대시보드 "고객 유형 다시 찾기" 버튼 (`/api/clusters/run`)
- 고객 유형 요약 카드

즉 **ML 기능 전체가 로컬에서만 동작하는 상태**일 가능성이 있습니다. 이게 사실이면 6단계 설계가 통째로 달라집니다.

## 확인할 것

| # | 항목 | 확인 방법 | 담당 |
|---|---|---|---|
| 0-1 | `CLUSTER_SERVER_URL` 실제 값 | Render 대시보드 → Environment | 팀 확인 필요 |
| 0-2 | Python 분류 서버가 어디서 도는지 | 별도 호스팅인지, 로컬 전용인지 | 팀 확인 필요 |
| 0-3 | `ml/output/.../site_snapshots/` 파일 생존 여부 | 재배포 후에도 스냅샷이 남아 있는지 | 확인 필요 |
| 0-4 | Cafe24 비회원 구매 허용 | Cafe24 관리자 → 쇼핑몰 설정 | **허용 예정 (확인됨)** |

**0-3이 "사라진다"면** 6단계에서 MongoDB 이관이 필수가 됩니다 (이미 그 방향으로 합의).

## 건드리는 파일

없음. 확인만 합니다.

---

# 1단계 — SDK 안정화

## 1-1. 세션이 1분마다 끊기는 문제

### 왜 고치는가

`core/sessionManager.js:26`

```js
const SESSION_TTL_MS = 60 * 1000; // 1분
```

같은 파일 주석과 `docs/notion-current-architecture.md`에는 **30분**으로 적혀 있습니다. 배포된 번들 `backend/public/gt.js`에도 `SESSION_TTL_MS = 60 * 1e3`으로 들어가 있어, **운영 중인 SDK가 실제로 1분**입니다.

Cafe24는 SPA가 아니라 **페이지 이동할 때마다 전체 새로고침**이 일어납니다. 즉 페이지를 넘길 때마다 `initSession()`이 다시 실행됩니다. 사용자가 상품 상세를 1분 넘게 보다가 장바구니로 가면 **다른 세션 ID**가 발급됩니다.

파급 효과:

- 퍼널이 성립하지 않음 (홈→상품→장바구니가 서로 다른 세션)
- 클러스터링 입력 시퀀스가 전부 길이 3~5짜리 파편 → 페르소나 구분 불가
- `is_returning`이 계속 `true`로 잘못 기록됨
- 유입 경로 attribution이 첫 페이지에서만 유효

**이 프로젝트의 핵심 가설이 "세션 흐름 기반 관심 저하 구간 분석"인데, 그 흐름 자체가 잘려 있습니다.**

### 무엇을 하는가

TTL 값을 하드코딩에서 빼내 **설정 주입 방식**으로 바꿉니다.

```js
// 변경 후 (개념)
initA({ session: { ttlMinutes: 30 } })
```

- 기본값은 주석·문서와 일치하는 **30분**
- 팀 상의 결과가 나오면 **숫자 하나만 바꾸면 됨** (재작업 없음)

> **팀 상의 필요 항목입니다.** 30분은 GA4 기본값이자 코드 주석의 원래 의도로 보여 임시 기본값으로 제안한 것입니다. 확정 전까지의 임시값이며, 확정되면 값만 교체합니다. → 5장 "팀 상의 목록" 참조

### 건드리는 파일

- `core/sessionManager.js` — TTL 상수 → 주입 파라미터
- `sdk-A.js` — `initA` options에서 세션 설정 전달 배선

---

## 1-2. 전송 실패 시 데이터가 사라지는 문제

### 왜 고치는가

`core/sender.js:71-77`

```js
const payload = JSON.stringify({ events: _buffer });
_buffer = [];              // ← 보내기 전에 버퍼를 비움

if (isUnload) { ... } else { _sendFetch(payload); }
```

`core/sender.js:83-91`

```js
function _sendFetch(payload) {
  fetch(COLLECT_URL, {...})
    .catch(() => {
      // 전송 실패 시 조용히 무시
    });
}
```

문제가 셋입니다.

1. **전송 전에 버퍼를 비웁니다.** 실패하면 복구할 원본이 없습니다.
2. **재시도가 없습니다.** 리스트의 "전송 실패 시 재시도 또는 무시 정책"은 현재 "무조건 무시"입니다.
3. **`res.ok`를 확인하지 않습니다.** 서버가 500을 반환해도 `.catch`가 안 걸리므로 성공으로 간주합니다.

가장 아픈 시나리오: **Render 무료 플랜의 콜드 스타트**입니다. 유휴 상태에서 첫 요청이 오면 서버가 깨어나는 데 30초 이상 걸립니다. 그동안 발생한 이벤트가 전량 유실됩니다. 이 구간은 **첫 방문자**이고, 첫 방문자는 유입 경로 분석에서 가장 중요한 세그먼트입니다.

### 무엇을 하는가

| 항목 | 내용 |
|---|---|
| 성공 판정 | `res.ok` 확인 후에만 버퍼에서 제거 |
| 재시도 | 지수 백오프 1s → 2s → 4s, 최대 3회 |
| 폐기 정책 | 3회 실패 시 폐기 (localStorage 백업은 하지 않음 — 용량·프라이버시 리스크) |
| 큐 상한 | 200건 초과 시 오래된 것부터 폐기 — 무한 증가 방지 |
| unload 경로 | 현행 유지 (`sendBeacon` → `fetch keepalive`). 재시도 불가능한 구간이라 손대지 않음 |

### 건드리는 파일

- `core/sender.js` — 이번 단계에서 가장 큰 변경

---

## 1-3. 재시도로 인한 중복 저장 방지

### 왜 하는가

**1-2와 반드시 세트로 가야 하는 작업입니다.**

재시도는 "서버가 저장은 했는데 응답이 유실된" 경우와 "서버가 저장을 못 한" 경우를 구분할 수 없습니다. 중복 방지 없이 재시도를 켜면 이벤트가 2~3배로 부풀고, **그 데이터로 클러스터링을 돌리면 결과가 완전히 오염됩니다.**

`backend/models/Event.js`에 현재 유니크 제약이 없습니다.

### 무엇을 하는가

- `Event` 스키마에 `{ session_id: 1, event_seq: 1 }` **unique 인덱스** 추가
- `collect.js`에서 MongoDB duplicate key 에러(코드 11000)를 **정상 응답으로 처리** — 이미 저장된 것이므로 성공으로 간주

### 주의 — 선행 확인 필요

기존 데이터에 이미 중복이 있으면 **인덱스 생성이 실패**합니다. 인덱스를 만들기 전에 중복 스캔을 먼저 돌리고, 중복이 있으면 정리 방침을 다시 논의합니다.

### 건드리는 파일

- `backend/models/Event.js`
- `backend/routes/collect.js`

---

## 1-4. 예외 격리 — 호스트 쇼핑몰 보호

### 왜 고치는가

```
try { } 블록 개수
sdk-A.js: 0   sdk-B.js: 0   sdk-C.js: 0   core/eventProcessor.js: 0
```

**SDK 전체에 try/catch가 하나도 없습니다.** "쇼핑몰 화면에 영향 없도록 예외 처리"는 미구현이 아니라 아예 없는 상태입니다.

남의 쇼핑몰에 삽입하는 SDK에서 이건 1순위 리스크입니다. Cafe24 스킨에서 예상 못 한 DOM 구조를 만나면 (예: `sdk-B.js`의 `e.target.closest()` 계열, `sdk-C.js:723`의 정규식 결과 사용) 리스너가 통째로 죽습니다.

더 나쁜 건, **죽었다는 사실을 알 방법이 없다는 점**입니다. 리스너 하나가 죽으면 그 유형의 이벤트가 세션 내내 안 잡히는데, 로그에는 아무것도 안 남습니다.

### 무엇을 하는가

- `handleRawEvent` 진입점과 각 리스너 콜백을 `safe()` 래퍼로 감쌈
- 예외 발생 시 조용히 삼키되, `data.sdk_error`에 기록해 원인 추적 가능하게 함
- 호스트 페이지 콘솔에는 아무것도 출력하지 않음

### 건드리는 파일

- `core/eventProcessor.js` — `safe()` 래퍼 정의 및 진입점 적용
- `sdk-A.js` — 리스너 등록부에 래퍼 적용
- `sdk-C.js` — 리스너 등록부에 래퍼 적용

> `sdk-B.js`는 이번 단계에서 건드리지 않습니다. 변경 범위를 좁혀 회귀 위험을 줄입니다.

---

## 1-5. scroll 리스너 passive 누락

### 왜 고치는가

`sdk-C.js:111`

```js
window.addEventListener('scroll', () => { ... });   // passive 없음
```

같은 파일 `sdk-C.js:1067-1084`의 다른 scroll 리스너에는 `{ passive: true }`가 붙어 있습니다. **이것만 누락**입니다.

passive가 없으면 브라우저가 "이 핸들러가 `preventDefault()`를 호출할 수도 있다"고 가정하고 스크롤을 기다립니다. 모바일에서 스크롤이 끊기는 원인이 됩니다. 한 줄짜리 수정이지만 "쇼핑몰 화면에 영향 없도록"의 직접적인 항목입니다.

### 건드리는 파일

- `sdk-C.js` (111번 줄)

---

## 1-6. 항목 정정 — "비동기 전송"은 이미 되어 있습니다

원래 작업 리스트의 **"비동기 전송"은 이미 구현되어 있습니다.** `core/sender.js`가 5초 주기 + 버퍼 30개 기준으로 배치 전송하고, unload 시에는 `sendBeacon`으로 넘깁니다. 여기 더 손댈 것이 없습니다.

실제로 안 되는 것은 **실패 처리**입니다. 리스트를 그대로 따라가면 이미 되는 것에 시간을 쓰고 정작 유실 문제는 못 잡습니다.

> **제안: 리스트 항목을 "비동기 전송" → "전송 신뢰성 (재시도·중복방지)"로 변경**

---

## 1단계 완료 기준

- [ ] 브라우저에서 3개 페이지를 5분에 걸쳐 이동했을 때 **session_id가 하나로 유지**됨
- [ ] 네트워크를 강제로 끊고 이벤트 발생 → 복구 후 **누락 없이 도착**
- [ ] 같은 배치를 강제로 2회 전송 → MongoDB에 **1건만 저장**
- [ ] 임의로 예외를 던지는 DOM에서 SDK가 죽지 않고 나머지 이벤트가 계속 수집됨
- [ ] 호스트 페이지 콘솔에 GhostTracker 관련 에러가 **0건**

---

# 2단계 — 유입 경로 추적

## 왜 하는가

원래 리스트에는 "유입 경로 추적 **확인**"으로 되어 있으나, **확인이 아니라 구현이 필요한 상태**입니다. 일정 산정 시 이 점을 반영해야 합니다.

### 문제 1 — UTM 파라미터가 절반만 수집됨

`core/sessionManager.js:_parseUTM()`

```js
return {
  utm_source:   params.get('utm_source')   || '',
  utm_campaign: params.get('utm_campaign') || '',
};
```

`utm_source`, `utm_campaign` 둘만 읽습니다. 그런데 `backend/models/Event.js`에는 **`utm_medium` 필드가 정의되어 있습니다.** SDK가 채우지 않으므로 **항상 빈 값**입니다. 스키마와 수집이 불일치합니다.

### 문제 2 — first-touch 저장이 없음

현재 유입 경로는 서버가 `$first`(received_at 순)로 추정합니다 (`backend/routes/logs.js:43-45`). 배치 전송 도착 순서가 뒤집히면 틀린 값이 나옵니다.

### 문제 3 — 결제 후 referrer가 오염됨

실측 결과, Cafe24 결제는 **별도 팝업 창**에서 PG사(이니시스/토스페이먼츠/KCP 등)로 넘어갑니다. 돌아오면 `document.referrer`가 **PG사 도메인**이 됩니다. first-touch를 저장해두지 않으면 **주문에 성공한 고객의 유입 경로가 전부 "이니시스"로 기록**됩니다. 가장 중요한 세그먼트의 attribution이 통째로 날아갑니다.

### 문제 4 — Instagram 유입이 "직접 방문"으로 집계됨

Instagram 인앱 브라우저는 `document.referrer`를 보내지 않습니다. `backend/routes/logs.js:14` `prettySourceName()`은 빈 값을 `'직접 방문'`으로 처리합니다.

**Instagram 유입이 안 잡히는 게 정상 동작인 상태**입니다. 원래 리스트에 "Instagram/Notion/GitHub 등"이 명시되어 있는데, 이대로면 Instagram만 영영 안 나옵니다.

## 무엇을 하는가

| # | 작업 | 해결하는 문제 |
|---|---|---|
| 2-1 | `utm_medium`, `utm_term`, `utm_content` 수집 추가 | 문제 1 |
| 2-2 | 최초 진입 시 UTM·referrer를 localStorage에 **first-touch로 고정 저장** | 문제 2, 3 |
| 2-3 | 자사 도메인 referrer는 무시 (내부 이동을 유입으로 오인 방지) | 문제 2 |
| 2-4 | PG 도메인 목록을 referrer 무시 대상에 추가 | 문제 3 |
| 2-5 | User-Agent 기반 인앱 브라우저 판별 (Instagram, KakaoTalk, Naver 등) | 문제 4 |
| 2-6 | 서버 집계를 `$first` 추정에서 **저장된 first-touch 값 사용**으로 전환 | 문제 2 |

## 건드리는 파일

- `core/sessionManager.js` — UTM 확장, first-touch 저장, 인앱 판별
- `backend/models/Event.js` — first-touch 필드 추가
- `backend/routes/logs.js` — `prettySourceName()`, `deriveSourceName()`, `buildSessionPipeline()` 수정

## 완료 기준

- [ ] `?utm_source=instagram&utm_medium=social&utm_campaign=test`로 진입 후 3페이지 이동 → **모든 이벤트에 동일한 first-touch 값**
- [ ] Instagram 앱에서 링크 진입 시 유입 경로가 **"Instagram"**으로 집계 (직접 방문 아님)
- [ ] 결제 팝업 후 복귀했을 때 유입 경로가 **PG사로 바뀌지 않음**

---

# 3단계 — Cafe24 어댑터 (Layer 0)

## 왜 이 설계로 바꾸는가

`https://toridos.cafe24.com` 실측 결과, **현재 휴리스틱 추론 방식으로는 Cafe24에서 이커머스 이벤트가 거의 잡히지 않습니다.**

| 행동 | 실제 DOM | 현재 감지 |
|---|---|---|
| 목록에서 장바구니 담기 | `<img alt="장바구니 담기">` + 텍스트 `"Cart"` | ❌ |
| 상세에서 장바구니 담기 | 텍스트 `"장바구니"` | ✅ |
| 바로구매 | 텍스트 `"바로 구매"` | ❌ |
| 수량 +/- | `<a href="javascript:;"><img alt="up"></a>` | ❌ |
| 옵션 선택 | `<a href="#none">옵션선택</a>` 커스텀 드롭다운 | ❌ |
| 결제 | 별도 팝업 창 (PG사 도메인) | ❌ (측정 불가) |

**상품 상세의 "장바구니" 버튼 하나를 빼면 전부 0건입니다.**

여기서 휴리스틱 정규식을 Cafe24에 맞춰 늘리는 방법도 있지만, 스킨이 바뀌면 또 깨집니다. 실측 중 더 나은 길을 발견했습니다.

### 핵심 발견 — Cafe24가 정답을 meta 태그로 제공합니다

상품 상세 페이지 head:

```html
<meta name="path_role" content="PRODUCT_DETAIL">
<meta property="product:productId" content="45">
<meta property="product:price:amount" content="105000">
<meta name="design_html_path" content="/product/detail.html">
```

홈에서는 `path_role: MAIN`입니다.

**URL 정규식으로 추론할 필요가 없습니다.** Cafe24 시스템이 페이지 타입과 상품 ID를 표준 meta로 보장합니다. 스킨 디자인이 바뀌어도, SEO URL 설정이 바뀌어도 이 값은 유지됩니다.

### 현재 상품 ID 추출이 실패하는 이유

`sdk-C.js:689`

```js
const PRODUCT_HREF = /\/(?:product|p|item|goods|shop)\/([^/?#]+)/i;
```

이 몰의 상품 상세 경로는 `/product/레이스-디테일-미디-원피스/45/category/1/display/6/`이고, 브라우저의 `window.location.pathname`은 **퍼센트 인코딩된 상태**입니다.

```
match[1] = "%EB%A0%88%EC%9D%B4%EC%8A%A4-%EB%94%94%ED%85%8C%EC%9D%BC-%EB%AF%B8%EB%94%94-%EC%9B%90%ED%94%BC%EC%8A%A4"
```

**진짜 상품번호 `45`는 바로 다음 세그먼트에 있는데 못 잡습니다.** fallback인 `params.get('product_id')`도 Cafe24는 파라미터명이 `product_no`라 `null`입니다.

## 무엇을 하는가

### 3-1. 감지 계층 구조에 Layer 0 추가

```
Layer 0: 플랫폼 어댑터 (Cafe24 meta 기반)     ← 신규. 확정값
Layer 1: data-ghost-role 명시 마킹              (기존)
Layer 2: 휴리스틱 추론                          (기존, fallback)
```

Layer 0이 붙으면 **페이지 타입과 상품 ID가 추론이 아니라 확정값**이 됩니다.

플랫폼 감지는 `<meta name="path_role">` 존재 여부로 판단하고, 없으면 기존 Layer 1/2로 그대로 떨어집니다. **Cafe24가 아닌 사이트의 동작은 바뀌지 않습니다.**

### 3-2. 플랫폼 무관 개선 3건

Layer 0과 별개로, 다른 쇼핑몰에도 이득이 되는 수정입니다.

| # | 작업 | 근거 |
|---|---|---|
| a | `img alt` / `title` 속성을 텍스트 후보에 추가 | 수량 버튼(`alt="up"`), 목록 장바구니(`alt="장바구니 담기"`) 두 건이 한 번에 해결됨. `sdk-C.js:703-712`의 `textOf()` / `matchesPatterns()`는 현재 `textContent`와 `aria-label`만 봄 |
| b | `change` 핸들러에 Layer 2 fallback 추가 | `sdk-C.js:857-860`이 `if (!el) return`으로 마킹 없으면 즉시 종료. `click`에는 있는 fallback이 `change`에는 없음 |
| c | `PURCHASE_TEXT`에 `/바로\s*구매/`, `/^구매$/` 추가 | `sdk-C.js:684-687` 현재 패턴이 `"바로 구매"`를 못 잡음 |

### 3-3. URL 정규화

- `?icid=MAIN.product_listmain_5` — Cafe24 내부 클릭 추적 파라미터가 **모든 상품 링크**에 붙습니다. `page_url`이 진입 경로마다 달라져 집계가 흩어집니다. 제거 후 저장합니다.
- 모바일 도메인(`m.` 접두어) 정규화 — 같은 몰이 대시보드에 사이트 2개로 뜨는 것을 방지합니다 (`backend/routes/collect.js:18`의 `origin` 기준 분리 때문).

### 3-4. 측정 범위 명시 — 결제 팝업은 포기

실측 결과 Cafe24 결제는 iframe이 아니라 **`window.open` 별도 창**이고, PG사 도메인으로 넘어갑니다.

> "본 결제 창은 결제완료 후 자동으로 닫히며, 결제 진행 중에 본 결제 창을 닫으시면 주문이 되지 않으니..."

남의 도메인이므로 기술적으로 측정할 방법이 없습니다. **"결제창 진입까지 측정"으로 범위를 명시적으로 자릅니다.** 이건 한계가 아니라 설계 결정이므로 문서와 발표자료에 명시합니다.

## 건드리는 파일

| 파일 | 변경 |
|---|---|
| `core/platformAdapter.js` | **신규** — Layer 0 플랫폼 감지 및 Cafe24 어댑터 |
| `sdk-C.js` | Layer 0 연동, `textOf()`/`matchesPatterns()`에 alt·title 추가, `change` fallback, 구매 텍스트 패턴 확장 |
| `core/eventProcessor.js` | Layer 0 확정값을 공통 필드로 첨부 |
| `core/sessionManager.js` | URL 정규화 (`icid` 제거) |
| `backend/routes/collect.js` | `origin` 모바일 도메인 정규화 |
| `index.js` | 어댑터 초기화 배선 |

## 완료 기준

`https://toridos.cafe24.com`에서 다음 시나리오를 수행했을 때:

- [ ] 상품 상세 진입 → `product_id = "45"` (인코딩된 한글 아님)
- [ ] 목록에서 Cart 아이콘 클릭 → `add_to_cart` 발생
- [ ] 수량 +/- 클릭 → `quantity_change` 발생
- [ ] 옵션 선택 → `option_select` 발생
- [ ] 바로구매 클릭 → `purchase_click` 발생
- [ ] 페이지 타입이 meta 기준으로 정확히 기록 (`MAIN`, `PRODUCT_DETAIL` 등)
- [ ] 팀원 사이트(비-Cafe24)에서 기존과 동일하게 동작 (회귀 없음)

---

# 4단계 — 페이지별 이벤트 매핑

## 왜 하는가

### 문제 1 — 장바구니가 결제 화면으로 분류됨

`ml/semantic_event_mapper.py:166-169`

```python
if any(k in path for k in ("/checkout", "/order", "/payment", "/pay", "/결제", "/주문")):
    return "CHECKOUT"

if any(k in path for k in ("/cart", "/basket", "/bag", "/장바구니")):
    return "CART"
```

Cafe24 장바구니 경로는 **`/order/basket.html`**입니다. checkout 판정이 먼저 오고 키워드에 `/order`가 있으므로, **Cafe24 장바구니가 전부 CHECKOUT으로 분류**됩니다.

`backend/routes/logs.js:261` `screenLabel()`에도 **동일한 순서 버그**가 있습니다.

결과: "많이 멈춘 화면 TOP"이 통째로 틀립니다.

### 문제 2 — ORDER_SUCCESS 페이지 타입이 존재하지 않음

현재 PAGE 어휘는 `HOME / PRODUCT / CART / CHECKOUT / CATEGORY / REVIEW / UNKNOWN` 뿐입니다. **주문 성공 페이지 타입이 없습니다.**

그래서 전환 판정이 이렇게 되어 있습니다.

`backend/routes/logs.js:145` — 클릭/호버 텍스트에 `주문이 완료`라는 **문자열이 있는지 정규식 매칭**

즉 주문 완료 페이지에서 사용자가 그 문구를 클릭하거나 호버해야만 전환으로 집계됩니다. **결제하고 창을 닫으면 0건**입니다. 대시보드의 "주문 성공 수"가 실제 주문 수와 무관합니다.

### 문제 3 — 리뷰 게시판이 UNKNOWN

Cafe24 리뷰 경로는 `/board/상품-사용후기/4/` 와 `/board/product/list.html?board_no=4&...` 입니다.

`infer_page`의 REVIEW 키워드는 `"/review", "/reviews", "/후기", "/리뷰"`인데, 실제 경로는 `/상품-사용후기/`라 **`후기` 앞에 `용`이 붙어 부분문자열 매칭에 걸리지 않습니다.** → UNKNOWN

`screenLabel()`에서는 이 페이지들이 전부 **'홈 화면'**으로 집계됩니다. 마이페이지(`/myshop/index.html`), 로그인(`/member/login.html`)도 마찬가지입니다.

## 무엇을 하는가

- `ORDER_SUCCESS` 페이지 타입 신설 → 전환 판정을 **텍스트 정규식에서 페이지 도달 기준으로 전환**
- cart / checkout 판정 순서 수정 및 Cafe24 경로 반영
- 3단계 Layer 0의 `path_role`을 **1순위 근거로 사용**, URL 추론은 fallback으로 강등
- `BOARD`(게시판), `MYPAGE`, `MEMBER` 페이지 타입 추가 검토
- SDK 쪽과 Python 쪽 **양쪽의 매핑 규칙을 한 곳에서 관리**할 수 있도록 정리 (현재 JS와 Python에 같은 로직이 중복되어 한쪽만 고치는 사고가 발생 중)

## 건드리는 파일

- `ml/semantic_event_mapper.py` — `infer_page()`, PAGE 어휘
- `backend/routes/logs.js` — `screenLabel()`, `buildSessionPipeline()`의 전환 판정
- `core/eventProcessor.js` — event_token vocab에 신규 페이지 반영

## 주의

PAGE 어휘를 바꾸면 **기존 학습 모델의 vocab과 불일치**가 생깁니다. `ml/output/`의 `vocab.json`, `cluster_meta.json`, 학습된 `.pt` 파일과의 호환성을 먼저 확인하고, 재학습이 필요하면 별도 작업으로 분리합니다.

---

# 5단계 — 운영자 대시보드 1차 고도화

## 왜 하는가

### 문제 1 — "오늘 방문자 수"가 오늘 기준이 아님

`backend/routes/logs.js:241`

```js
Event.distinct('session_id', filter),   // 날짜 필터 없음
```

`visitor_count`는 **전체 기간 누적 세션 수**입니다. KST 기준 처리도 없습니다. 대시보드에 "오늘 방문자"로 표시되고 있다면 완전히 틀린 수치입니다.

### 문제 2 — 매 새로고침마다 전체 컬렉션 스캔

`/operator-summary`와 `/sources`가 기간 필터 없이 `Event.aggregate(buildSessionPipeline(filter))`를 호출합니다. **컬렉션 전체를 매번 스캔**합니다. 데이터가 쌓이면 대시보드가 느려지다 죽습니다. 시연 중에 터지면 곤란합니다.

## 무엇을 하는가

원래 리스트의 7개 카드를 기준으로 합니다.

| 카드 | 현재 상태 | 작업 |
|---|---|---|
| 오늘 방문자 수 | ❌ 전체 기간 누적 | KST 기준 당일 필터 추가 |
| 탐색 중지 신호 수 | ⚠️ 집계는 되나 기간 없음 | 기간 필터 적용 |
| 주문 성공 수 | ❌ 텍스트 정규식 의존 | 4단계 `ORDER_SUCCESS` 기반으로 교체 |
| 유입 경로 TOP | ⚠️ 2단계 전까지 부정확 | 2단계 first-touch 기반으로 교체 |
| 많이 멈춘 화면 TOP | ❌ 장바구니 오분류 | 4단계 매핑 수정 반영 |
| 문제 원인 TOP | ⚠️ 규칙 기반, 검증 안 됨 | 실데이터로 규칙 재검토 |
| 고객 유형 요약 | ⚠️ 0단계 결과에 의존 | ML 서버 연결 확인 후 |

추가로:

- 기간 선택 UI (오늘 / 7일 / 30일) 도입
- 집계 쿼리에 `received_at` 범위 필터 적용
- MongoDB 인덱스 점검 (`{ origin: 1, received_at: -1 }` 복합 인덱스 검토)

## 건드리는 파일

- `backend/routes/logs.js` — `/stats`, `/operator-summary`, `/sources` 전반
- `backend/public/operator-dashboard.html` — 기간 선택 UI, 카드 바인딩
- `backend/models/Event.js` — 인덱스 추가

---

# 6단계 — 클러스터링 실행·저장 구조 안정화

## 왜 하는가

### 문제 1 — 스냅샷이 재배포마다 사라짐

`backend/routes/clusters.js:30`

```js
const SNAPSHOT_DIR = path.join(__dirname, '../../ml/output/unsupervised_semantic/site_snapshots');
```

스냅샷을 **파일 시스템**에 저장합니다. Render는 파일 시스템이 휘발성이라 재시작·재배포하면 전부 사라집니다.

사라지면 `mode=frozen` 요청이 실시간 재분류로 fallback됩니다 (`clusters.js:569-586`). 즉 **"실행 시점 기준으로 결과 고정"이 성립하지 않고, 볼 때마다 결과가 달라집니다.** 리스트의 첫 번째 요구사항이 구조적으로 불가능한 상태입니다.

→ **MongoDB 이관으로 합의됨**

### 문제 2 — `/api/clusters/sessions`의 CSV 파싱이 취약

`backend/routes/clusters.js:665`

```js
const cols = line.split(',');
```

CSV를 단순 `split(',')`으로 파싱합니다. 상품명이나 라벨에 쉼표가 들어가면 컬럼이 밀립니다. 이 몰의 상품명(`레이스 디테일 미디 원피스`)에는 없지만, Gemini가 생성하는 클러스터 라벨에는 들어갈 수 있습니다.

## 무엇을 하는가

| # | 작업 |
|---|---|
| 6-1 | `site_snapshots` 파일 → **MongoDB 컬렉션 이관** |
| 6-2 | 스냅샷에 실행 시각·모델 버전·세션 수 메타 기록 → 재현 가능성 확보 |
| 6-3 | 사이트별(origin) 스냅샷 분리 검증 — 3단계 모바일 도메인 정규화 반영 |
| 6-4 | 작은 클러스터 / 미분류(noise) / 품질 지표(silhouette, DB index) 대시보드 노출 |
| 6-5 | CSV 파싱 개선 또는 CSV 의존 제거 |

## 건드리는 파일

- `backend/routes/clusters.js` — 스냅샷 저장·조회 로직
- `backend/models/` — 스냅샷 모델 **신규**
- `backend/public/operator-dashboard.html` — 품질 지표 표시

## 전제

**0단계 결과에 따라 범위가 크게 달라집니다.** Python 분류 서버가 배포 환경에서 안 돌고 있다면, 스냅샷 저장 구조보다 **실행 경로 확보**가 먼저입니다.

---

# 5장. 팀 상의가 필요한 항목

| # | 항목 | 배경 | 임시 조치 |
|---|---|---|---|
| 1 | **세션 TTL 확정값** | 코드는 1분, 주석·문서는 30분. GA4 기본값은 30분 | 설정값으로 분리하고 임시 기본값 30분. 확정 시 숫자만 교체 |
| 2 | **`CLUSTER_SERVER_URL` 실제 값** | 배포 환경 ML 동작 여부가 여기 달림 | 0단계에서 확인 |
| 3 | **Python 분류 서버 호스팅 방안** | 2번 결과가 "없음"이면 별도 호스팅 필요 | 2번 확인 후 |
| 4 | **기존 중복 데이터 처리** | unique 인덱스 생성 전 정리 필요 여부 | 중복 스캔 후 결정 |
| 5 | **PAGE 어휘 변경 시 모델 재학습** | 4단계에서 vocab 불일치 발생 | 호환성 확인 후 별도 작업 분리 |
| 6 | **측정 범위: 결제 팝업 제외** | 기술적으로 불가능. 발표자료에 명시 필요 | 설계 결정으로 문서화 |

---

# 부록 A. 실측 데이터

## A-1. toridos.cafe24.com URL 구조

| 화면 | 실제 경로 | 현재 `infer_page` |
|---|---|---|
| 홈 | `/` | HOME ✅ |
| 카테고리 | `/category/아우터/42/` | CATEGORY ✅ |
| 상품 상세 | `/product/{한글슬러그}/45/category/1/display/6/` | PRODUCT ✅ |
| 장바구니 | `/order/basket.html` | **CHECKOUT ❌** |
| 리뷰 게시판 | `/board/상품-사용후기/4/` | **UNKNOWN ❌** |
| 상품 리뷰 목록 | `/board/product/list.html?board_no=4&link_product_no=45` | **UNKNOWN ❌** |
| 이미지 확대 | `/product/image_zoom2.html?product_no=45&cate_no=1` | PRODUCT |
| 마이페이지 | `/myshop/index.html` | UNKNOWN |
| 로그인 | `/member/login.html` | UNKNOWN |

## A-2. Cafe24 meta 태그 (상품 상세)

```
path_role:              PRODUCT_DETAIL      ← 페이지 타입 확정값
product:productId:      45                  ← 상품 ID 확정값
product:retailer_item_id: 45
product:price:amount:   105000
product:price:currency: KRW
design_html_path:       /product/detail.html  ← 스킨 파일 경로
og:type:                product
```

홈페이지에서는 `path_role: MAIN`.

## A-3. 코드 근거 인덱스

| 사실 | 위치 |
|---|---|
| 세션 TTL 1분 | `core/sessionManager.js:26` |
| 배포 번들도 1분 | `backend/public/gt.js` (`SESSION_TTL_MS = 60 * 1e3`) |
| 전송 전 버퍼 비움 | `core/sender.js:71` |
| 실패 시 무시 | `core/sender.js:88-90` |
| try/catch 0개 | `sdk-A.js`, `sdk-B.js`, `sdk-C.js`, `core/eventProcessor.js` |
| scroll passive 누락 | `sdk-C.js:111` (비교: 같은 파일 1084줄에는 있음) |
| 상품 ID 정규식 | `sdk-C.js:689` |
| `change` fallback 없음 | `sdk-C.js:857-860` |
| `textOf`가 alt 미확인 | `sdk-C.js:703-712` |
| 구매 텍스트 패턴 | `sdk-C.js:684-687` |
| UTM 2개만 파싱 | `core/sessionManager.js` `_parseUTM()` |
| `utm_medium` 스키마만 존재 | `backend/models/Event.js` |
| cart/checkout 순서 버그 (Python) | `ml/semantic_event_mapper.py:166-169` |
| cart/checkout 순서 버그 (Node) | `backend/routes/logs.js:261` |
| 전환 판정 텍스트 정규식 | `backend/routes/logs.js:145` |
| 방문자 수 날짜 필터 없음 | `backend/routes/logs.js:241` |
| ML 서버 기본값 localhost | `backend/routes/clusters.js:19`, `classify.js:23` |
| 스냅샷 파일 저장 | `backend/routes/clusters.js:30` |
| CSV 단순 split | `backend/routes/clusters.js:665` |
| origin = 요청 헤더 | `backend/routes/collect.js:18` |

---

# 부록 B. 변경 파일 요약

| 파일 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `core/sessionManager.js` | ● | ● | ● | | | |
| `core/sender.js` | ● | | | | | |
| `core/eventProcessor.js` | ● | | ● | ● | | |
| `core/platformAdapter.js` **(신규)** | | | ● | | | |
| `sdk-A.js` | ● | | | | | |
| `sdk-C.js` | ● | | ● | | | |
| `index.js` | | | ● | | | |
| `backend/models/Event.js` | ● | ● | | | ● | |
| `backend/routes/collect.js` | ● | | ● | | | |
| `backend/routes/logs.js` | | ● | | ● | ● | |
| `backend/routes/clusters.js` | | | | | | ● |
| `backend/public/operator-dashboard.html` | | | | | ● | ● |
| `ml/semantic_event_mapper.py` | | | | ● | | |

`sdk-B.js`는 전 단계에서 변경하지 않습니다.

---

# 부록 C. 배포 절차

SDK를 수정한 뒤에는 번들 재생성이 필요합니다.

```bash
node backend/build.js     # index.js → backend/public/gt.js
```

`backend/public/gt.js`가 실제 쇼핑몰에 삽입되는 파일이므로, **이 단계를 빠뜨리면 수정이 반영되지 않습니다.**

Cafe24 삽입 위치는 스킨 레이아웃 파일의 `</head>` 직전입니다. 개별 페이지 스킨이 아니라 **공통 레이아웃**에 넣어야 전 페이지에 적용됩니다.

```html
<script src="https://two026-capstone.onrender.com/gt.js"></script>
```
