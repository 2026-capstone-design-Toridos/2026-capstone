# Python 서비스 배포 가이드

> 목적: 지금 배포 환경에서 죽어 있는 ML 기능을 살린다
> 대상: Render
> 소요: 1~2시간 (문제 없으면 40분)

---

## 왜 필요한가

현재 Render에는 **Node 서비스 하나**만 떠 있습니다. 그런데 코드는 처음부터 Python 서버가 따로 있다는 전제로 작성돼 있습니다.

```js
// backend/routes/classify.js
const CLUSTER_SERVER = process.env.CLUSTER_SERVER_URL || 'http://localhost:5002';
const res = await fetch(`${CLUSTER_SERVER}/classify`, {...});
```

그 서버가 어디에도 없어서 `localhost:5002`로 붙으려다 실패합니다. 확인:

```
https://two026-capstone.onrender.com/api/classify/health?key=<접근키>
→ {"proxy":"ok","python":"unreachable"}
```

**새 구조를 만드는 게 아니라 원래 설계대로 돌려놓는 작업입니다.**

살아나는 기능:

- 운영자 대시보드 "이 고객 분석"
- "고객 유형 다시 찾기"
- 고객 유형 요약 (실시간 분류)
- 주간 PDF 리포트 (2단계까지 하면)

---

## 전체 그림

```
Render 서비스 ①  Node   (지금 있는 것)
  수집 /collect · 대시보드 · 조회 API
        │
        │  HTTP (CLUSTER_SERVER_URL)
        ▼
Render 서비스 ②  Python (새로 만들 것)
  cluster_server.py  ← 고객 유형 분류
  report_html.py     ← PDF 리포트 (2단계)
```

두 서비스가 **같은 저장소**를 봅니다. Render는 서비스마다 Root Directory를 다르게 잡을 수 있습니다.

| | 서비스 ① | 서비스 ② |
|---|---|---|
| Root Directory | `backend` | `ml` |
| 런타임 | Node | Python |
| 시작 명령 | `node server.js` | `python cluster_server.py ...` |

---

## 0단계 — 로컬에서 먼저 확인 (필수)

**배포 전에 반드시 로컬에서 띄워보세요.** 여기서 나오는 `mode` 값에 따라 배포 사양이 달라집니다.

```bash
cd ~/Desktop/software/4grade/2026-capstone/ml
pip install flask numpy pymongo
python cluster_server.py
```

다른 터미널에서:

```bash
curl http://localhost:5002/health
```

### 결과에 따라 갈립니다

**A. `{"status":"ok","mode":"bert",...}`**

torch가 설치된 환경이라 BERT 모드로 떴습니다. 배포 시 torch가 없으면 `tfidf`로 떨어지는데, **그때도 동작하는지** 확인이 필요합니다. torch를 잠시 제거하거나 가상환경을 새로 만들어 다시 띄워보세요.

**B. `{"status":"ok","mode":"tfidf",...}`**

torch 없이도 동작합니다. **무료 플랜으로 갈 수 있습니다.** 가장 좋은 시나리오입니다.

**C. 에러 / `status`가 ok가 아님**

`cluster_meta.json`에 TF-IDF 중심점이 없어서일 가능성이 높습니다. 확인:

```bash
python -c "import json; m=json.load(open('output/unsupervised_semantic/cluster_meta.json')); print([k for k in m if 'tfidf' in k.lower()])"
```

빈 배열이 나오면 TF-IDF fallback을 쓸 수 없습니다. **torch가 필요하고, 무료 플랜으로는 어렵습니다.** 이 경우 조현님과 상의가 필요합니다.

> **이 결과를 먼저 공유해주세요.** C가 나오면 배포 방식 자체를 다시 정해야 합니다.

---

## 1단계 — 분류 서버만 먼저 배포

리포트(PDF)는 무거우니 분류 서버부터 띄워 동작을 확인합니다.

### 1-1. Render에서 서비스 생성

1. https://dashboard.render.com → **New** → **Web Service**
2. 저장소 `2026-capstone-design-Toridos/2026-capstone` 선택
3. 아래처럼 설정

| 항목 | 값 |
|---|---|
| Name | `two026-capstone-ml` (자유) |
| Language | **Python 3** |
| Branch | `main` |
| **Root Directory** | `ml` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | 아래 참고 |
| Instance Type | Free (먼저 시도) |

### 1-2. Start Command

```
python cluster_server.py --host 0.0.0.0 --port $PORT --model_dir output/unsupervised_semantic
```

**`$PORT`가 중요합니다.** Render는 자기가 정한 포트로 서비스가 뜨기를 기대합니다. `5002`로 고정하면 "포트를 못 찾았다"며 배포가 실패합니다.

`--host 0.0.0.0`도 필수입니다. 기본값이 이미 `0.0.0.0`이라 생략해도 되지만 명시하는 편이 안전합니다.

### 1-3. requirements.txt 확인

`ml/requirements.txt`가 이미 만들어져 있습니다. 1단계에서는 **1·2단계 블록만 살리고 3단계(torch)는 주석 처리된 상태 그대로** 두세요.

PDF까지 한 번에 하지 않을 거면 2단계 블록(matplotlib, weasyprint, Pillow)도 주석 처리하면 빌드가 빨라집니다.

### 1-4. 환경변수

| Key | Value |
|---|---|
| `MONGODB_URI` | Node 서비스와 같은 값 |
| `PYTHON_VERSION` | `3.11.9` (선택. 미지정 시 Render 기본값) |

### 1-5. 배포 확인

배포가 끝나면 주소가 나옵니다. 예: `https://two026-capstone-ml.onrender.com`

```
https://two026-capstone-ml.onrender.com/health
```

```json
{"status":"ok","mode":"tfidf","n_clusters":12}
```

이게 나오면 성공입니다.

> 첫 요청은 30~50초 걸릴 수 있습니다(콜드 스타트). 응답이 없어도 기다려주세요.

---

## 2단계 — Node 서비스와 연결

기존 Node 서비스(`two026-capstone`)의 **Environment**에 추가합니다.

| Key | Value |
|---|---|
| `CLUSTER_SERVER_URL` | `https://two026-capstone-ml.onrender.com` |

**끝에 슬래시를 붙이지 마세요.** 코드가 `${CLUSTER_SERVER}/classify` 형태로 이어붙이기 때문에 `//classify`가 됩니다.

저장하면 재배포됩니다. 확인:

```
https://two026-capstone.onrender.com/api/classify/health?key=<접근키>
```

```json
{"proxy":"ok","python":{"status":"ok","mode":"tfidf","n_clusters":12}}
```

`python`이 `unreachable`에서 실제 응답으로 바뀌면 연결된 것입니다.

그다음 운영자 대시보드에서 **"이 고객 분석"** 버튼을 눌러보세요.

---

## 3단계 — PDF 리포트 (선택, 나중에 해도 됨)

분류 서버가 안정적으로 뜬 뒤에 진행하세요.

### 3-1. 시스템 라이브러리

`weasyprint`는 파이썬 패키지만으로는 안 되고 시스템 라이브러리가 필요합니다. Render의 Build Command를 이렇게 바꿉니다.

```
apt-get update && apt-get install -y libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0 && pip install -r requirements.txt
```

`requirements.txt`의 2단계 블록(matplotlib, weasyprint, Pillow) 주석을 해제합니다.

### 3-2. 이탈 캡처는 일단 빼세요

`exit_capture.py`는 Headless Chrome을 씁니다. **300MB 이상 추가되고 실행 중 메모리도 크게 먹어서 무료 플랜에서는 거의 확실히 죽습니다.**

`report_html.py`는 브라우저가 없으면 캡처를 건너뛰고 리포트를 만듭니다. 그대로 두면 됩니다.

### 3-3. PDF를 어디에 둘지

현재 `/api/report/weekly/download`는 **Node 서버의 디스크**에서 PDF를 찾습니다. Python 서비스가 만든 파일은 다른 서버에 있어서 안 보입니다.

두 방법 중 하나가 필요합니다.

| 방법 | 내용 |
|---|---|
| Python이 PDF를 응답으로 반환 | Node가 받아 전달. 매번 생성이라 느림 |
| **MongoDB에 저장** | Python이 저장, Node가 꺼냄. 재배포에도 살아남음 |

**MongoDB 방식을 권합니다.** 6단계(클러스터 스냅샷 이관)와 같은 방향입니다. 이건 코드 작업이 필요하니 조현님과 상의 후 진행하세요.

---

## 문제가 생기면

### 배포가 실패할 때

Render **Logs** 탭을 먼저 보세요.

| 로그 메시지 | 원인 | 해결 |
|---|---|---|
| `No open ports detected` | 포트 고정 | Start Command에 `--port $PORT` |
| `ModuleNotFoundError: flask` | 패키지 미설치 | Root Directory가 `ml`인지, Build Command 확인 |
| `Killed` / `Out of memory` | 메모리 초과 | torch·Chrome 제외. 그래도 안 되면 유료 플랜 |
| `FileNotFoundError: cluster_meta.json` | 경로 문제 | `--model_dir output/unsupervised_semantic` 확인 |

### 연결이 안 될 때

```
https://두번째서비스.onrender.com/health          ← 여기가 되는지 먼저
https://two026-capstone.onrender.com/api/classify/health?key=<키>  ← 그다음
```

앞이 되고 뒤가 안 되면 `CLUSTER_SERVER_URL` 오타(끝 슬래시, https 누락)를 의심하세요.

---

## 알아두실 점

**무료 플랜은 서비스마다 따로 잠듭니다.** 서비스가 둘이 되면 콜드 스타트도 두 곳에서 발생합니다. 대시보드에서 "이 고객 분석"을 처음 누르면 30~50초 걸릴 수 있습니다. 고장이 아닙니다.

**"고객 유형 다시 찾기" 버튼은 이걸로도 안 됩니다.** 그 기능은 Node가 `spawn('python')`으로 직접 실행하는 구조라, Python 서비스를 띄워도 Node 쪽에 python이 없는 건 그대로입니다. HTTP 호출로 바꾸는 코드 수정이 별도로 필요합니다.

**`GEMINI_API_KEY`는 이것과 무관합니다.** Gemini는 구글 클라우드 API라 실행 환경이 필요 없습니다. Node 서비스 환경변수에 키만 넣으면 됩니다. (다만 지금은 대시보드가 `prefer_local`로 Gemini 호출을 끄고 있어서, 키를 넣어도 문장이 안 바뀝니다. 별도 논의 필요)

---

## 체크리스트

- [ ] 0단계: 로컬에서 `/health` 확인, `mode` 값 공유
- [ ] 1-1: Render Web Service 생성 (Python 3, Root Directory `ml`)
- [ ] 1-2: Start Command에 `--port $PORT`
- [ ] 1-4: `MONGODB_URI` 설정
- [ ] 1-5: `https://두번째서비스.onrender.com/health` 응답 확인
- [ ] 2단계: Node 서비스에 `CLUSTER_SERVER_URL` 설정
- [ ] 2단계: `/api/classify/health`가 `unreachable`에서 바뀌는지 확인
- [ ] 대시보드 "이 고객 분석" 버튼 동작 확인
