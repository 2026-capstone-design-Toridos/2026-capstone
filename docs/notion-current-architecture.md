## SDK — 브라우저에서 행동 수집

쇼핑몰 <head>에 gt.js 한 줄 넣으면 동작. B·C가 날것들을 감지해서 A(core)로 넘기고, A/core가 공통 필드와 파생 이벤트를 붙여 서버로 보낸다.

- **index.js** — SDK 진입점. initA → initB → initC 순서로 세 모듈을 켜서 하나로 묶는다.
- **sdk-A.js** (Core) — 세션·환경·페이지 이동·세션 종료·비활성·화면 리사이즈를 직접 수집하고, B·C가 넘긴 raw 이벤트를 core/eventProcessor로 넘긴다. initA()로 시작. C는 subsection dwell 계산을 위해 **window.__GT**로 A랑 통신함.
- **sdk-B.js** — 클릭·마우스 이동·입력·포커스·붙여넣기·탭 이탈/복귀·hover·미디어·검색 같은 기본 상호작용을 감지해서 handleRawEvent로 A에 넘긴다. 자기가 판단은 안 하고 날것만 던지는 역할.
- **sdk-C.js** — 스크롤·섹션/서브섹션·이커머스(상품 클릭·옵션 선택·수량 변경·장바구니·구매 클릭)·리뷰 행동 담당. 얘도 handleRawEvent로 A에 넘김. 명시 마킹(data-ghost-role/data-section/data-subsection)을 우선 쓰고, 없으면 DOM id/class/text로 일부 자동 추론한다.
- **core/eventProcessor.js** — B·C에서 올라온 이벤트의 중앙 처리기. 공통 필드(session_id·event_seq·event_token·inter_event_gap) 붙이고, 파생 이벤트(rage_click, time_to_first_click, cart_abandon_flag)를 만들고, sender로 넘긴다. event_token vocab(이벤트 이름↔숫자)도 여기 있음.
- **core/sessionManager.js** — 세션 ID 발급, localStorage 기반 세션 재사용, 현재 페이지 컨텍스트 관리. 현재 코드상 localStorage 세션 재사용 TTL은 1분이고, sdk-A.js 쪽에 30분 비활성 세션 종료 타이머가 별도로 있다.
- **core/timeTracker.js** — 체류 시간, 첫 클릭까지 걸린 시간, 비활성 시간 같은 시간 기반 값 계산.
- **core/sender.js** — 가공 끝난 이벤트를 모아 /collect로 전송. 평소엔 fetch, 창 닫힐 땐 sendBeacon으로 떨어뜨림. 기본 수집 URL은 https://two026-capstone.onrender.com/collect.
- **backend/build.js** — 위 SDK 소스들을 묶어 public/gt.js 한 파일로 만드는 번들러. 개발/배포 번들 만들 때 사용.
- **backend/public/gt.js** — 실제 쇼핑몰에 붙이는 배포용 번들(빌드 결과물).
- **test-sdk.js** — 로컬/Vite 테스트용 SDK 진입점. debugEmit으로 이벤트를 콘솔에 찍어 확인할 때 사용.
- **vite.config.js** — test-sdk.js를 브라우저용 IIFE 번들로 만들기 위한 로컬 테스트 설정.
- **dist/ghosttracker.iife.js** — Vite 빌드 결과물. 로컬 테스트/배포 방식에 따라 참고용으로 남아있는 번들.

> SDK 흐름 한 줄: sdk-B / sdk-C (감지) → sdk-A (core 초기화·브릿지) → core/eventProcessor (공통필드·파생) → sender → /collect
> 

## Backend — 서버와 API (Node/Express, :4000)

- **backend/server.js** — 백엔드 시작점으로, public/(운영자 화면) 정적 서빙 + 모든 라우터 연결 + Mongo 붙고 나서 4000번으로 뜬다.
- **backend/db.js** — MongoDB Atlas 연결. 이미 연결되어 있으면 중복 연결하지 않는다.
- **backend/models/Event.js** — Mongo events 스키마. SDK가 보내는 모든 행동이 이 형식으로 저장됨(session_id·event_type·event_seq·page_url·data·origin·received_at 등). logs·classify·clusters가 세션 읽을 때 이걸 씀.
- **backend/routes/collect.js** — POST /collect 하나. SDK가 보낸 단일 이벤트 또는 이벤트 배열을 Mongo에 한 번에 저장. 수집의 입구.
- **backend/routes/logs.js** — 운영자 화면 실시간 집계 담당. 엔드포인트가 많다: /sites(사이트 목록) /stats(상단 KPI) /sessions(최근 고객) /operator-summary(막히는 화면·문제 원인·유입 성과·우선순위 한 방에) /sources(유입 경로) /(원시 로그). 전부 Mongo 집계.
- **backend/routes/classify.js** — "이 고객 분석". 토큰/이벤트를 Python 분류서버로 넘기는 프록시. /(토큰/이벤트로 분류) /batch /session/:sessionId(DB에서 세션 읽어 분류) /health. DB 세션을 읽을 때는 event_type·page·section·element_section 형태로 정규화해서 넘긴다.
- **backend/routes/clusters.js** — 고객 유형 결과. /(mode=frozen이면 저장 스냅샷, 아니면 실시간 재분류) /run(다시 찾기 — retrain_centroids.py 실행 + Gemini 라벨 + 사이트 스냅샷 저장) /sessions. retrain_centroids.py·cluster_server.py·cluster_meta.json·site_snapshots·Gemini와 엮임.
- **backend/routes/report.js** — 리포트. /cluster/:id(유형 리포트) /session(고객 리포트) /all /cache/clear /weekly/download(주간 PDF). 앞쪽 셋은 Gemini 자연어 생성, Gemini가 실패하면 로컬 preset/fallback 문장으로 응답. /weekly/download는 report_html.py가 미리 만들어 둔 PDF를 다운로드만 해줌.
- **backend/routes/predict.js** — 옛날 /api/predict 호환용 라우트. 지금 주 분류는 classify.js가 하지만, 기존 클라이언트가 죽지 않도록 Python 분류서버 /classify로 그대로 프록시한다.

## 화면

- **backend/public/operator-dashboard.html** — 운영자 화면 본체. UI·Chart.js·상태 관리·버튼 액션이 전부 여기. 실제로 부르는 API: /api/logs/{sites,stats,sessions,operator-summary,sources}, /api/logs?...(원시 로그), /api/classify/session/:id, /api/clusters?mode=frozen·/api/clusters/run, /api/report/cluster/:id·/session·/weekly/download.
- **backend/public/dashboard.html** — 초기 관리자 대시보드(실시간 이벤트 로그 위주). 지금은 operator-dashboard.html로 대체된 구버전.

---

# ml 폴더 파일별 정리

## 실제로 동작하는 것

실제로 사용 되어서 남겨두는게 좋다고 판단되는 파일들에 대해 적어둠

- **cluster_server.py** — 서비스가 직접 부르는 ML 분류 서버. Flask로 5002번 포트에 띄워두고, backend가 /classify로 세션을 던지면 어느 클러스터인지 돌려준다. 기본은 Transformer/BERT 임베딩 → cosine distance고, 모델 파일이 없으면 cluster_meta.json 안의 TF-IDF centroid fallback으로 떨어진다. ML 쪽 심장.
- **retrain_centroids.py** — cluster_meta.json에 저장된 하이퍼파라미터로 모델을 복원하고, MongoDB 세션을 읽어 centroid를 다시 계산한다. 기본은 EMA 업데이트(기존 클러스터 유지), --full이면 HDBSCAN으로 전체 재클러스터링. 수동으로도 돌리고, 운영자 화면 **“고객 유형 다시 찾기” 버튼(clusters.js)** 에서도 호출된다.
- **report_html.py** — cluster_meta.json의 프로파일을 읽어 고객 행동 분석 리포트를 HTML → PDF로 만든다. Gemini 인사이트·전환 퍼널·이탈 캡처 페이지까지 들어간다. 수동/배치로 미리 돌려 PDF를 만들어두면, backend의 /api/report/weekly/download는 그 만들어진 파일을 다운로드해주기만 한다.
- **exit_capture.py** — report_html.py 안에서 capture_exit_hotspots()로 불린다. MongoDB 이탈/위험 이벤트를 집계해 상위 이탈 지점을 찾고, Headless Chrome(CDP)으로 그 URL 스크린샷을 찍어 붉은 하이라이트를 덧입힌다. 리포트에 들어가는 “여기서 많이 나가요” 장면이 해당된다.
- **semantic_event_mapper.py** — raw SDK 이벤트(click, scroll_depth 등)를 PAGE|SEMANTIC|CONTEXTUAL 3파트 토큰으로 바꾸는 매핑 규칙. build_session_sequences.py가 import해서 쓴다. 시퀀스 생성 쪽의 핵심 중간 변환 계층.

## 학습 파이프라인 (순서대로 실행)

실서비스가 직접 부르진 않고, Colab이나 로컬에서 모델 만들 때 **위에서 아래로** 순서대로 돌리는 스크립트들.

- **etl_session_features.py** — MongoDB → 세션 단위 feature 테이블(CSV). 클릭 수·스크롤·이커머스·이탈 신호 같은 feature 수십 개를 뽑아낸다. XGBoost 학습(train_model)이나 탐색 분석용.
- **build_session_sequences.py** — MongoDB/CSV/JSON/JSONL raw 이벤트 → PAGE|SEMANTIC|CONTEXTUAL 토큰 시퀀스 CSV/JSONL. semantic_event_mapper.py로 변환한다. 다음 단계인 prepare_transformer_input의 입력이 된다.
- **semantic_vocab.py** — 위 토큰 시퀀스 CSV/JSONL을 읽어 vocab.json과 token_id 시퀀스를 만든다. vocab을 따로 관리해야 할 때 쓴다.
- **prepare_transformer_input.py** — 세션 시퀀스 CSV → Transformer 학습용 .pt 텐서. vocab 생성, CLS 토큰 삽입, truncate/padding, attention_mask, session_meta 저장까지 처리. train_transformer_encoder의 입력.
- **train_transformer_encoder.py** — Transformer Encoder를 Masked Token Prediction으로 학습하고 세션 임베딩(.npy)과 모델(.pt)을 저장. cluster_session_embeddings가 이 결과물을 갖다 쓴다.
- **cluster_session_embeddings.py** — session_embeddings.npy를 읽어 L2 정규화 + PCA 시각화 + HDBSCAN 클러스터링. cluster_results.csv·PCA 플롯·클러스터 요약 텍스트를 남긴다. 초기 클러스터 탐색 단계.
- **colab_export_artifacts.py** — Colab에서 학습 끝난 뒤 cluster_meta.json·cluster_centroids.npy·bert_encoder.pt를 Google Drive/운영 산출물 폴더로 내보내는 export 셀. cluster_server.py가 알아보는 형식으로 패키징한다.

## 외부 데이터 전처리 (Coveo 공개데이터용)

BERT/Transformer 사전학습을 Coveo SIGIR 2021 이커머스 데이터로 할 때만 돌린다.

- **coveo_semantic_mapper.py** — Coveo browsing_train.csv → 우리 PAGE|SEMANTIC|CONTEXTUAL 포맷. preprocess_coveo보다 가볍고 우리 vocab 형식에 맞춘 버전.
- **preprocess_coveo.py** — Coveo 데이터를 학습용으로 전처리(라벨 자동 생성·패딩·.pt 저장). csv.DictReader 기반이라 메모리는 안전한데 느리다.
- **preprocess_coveo_fast.py** — 위의 pandas 벡터화 버전. 기능은 같고 대용량 처리가 훨씬 빠르다.
- **convert_teammate_data.py** — 팀원의 transformer_input.pt를 우리 vocab 기준으로 재인코딩해 Colab 사전학습 데이터에 합칠 때. 팀원 vocab↔우리 vocab 토큰 매핑을 수동으로 정의한다.

## 학습 데이터 증강

- **synthetic_session_generator.py** — 12개 페르소나(impulsive, price_sensitive, cart_abandoner 등)를 정의해 합성 세션 시퀀스를 만든다. 실데이터가 적을 때 사전학습 데이터 보강용.
- **simulate_sessions.py** — Playwright로 실제 쇼핑몰(JH/DM/SY)에서 explorer·bouncer·buyer·wanderer·reviewer·indecisive 6가지 행동 패턴을 자동 시뮬레이션. SDK가 깔린 페이지에서 실제 이벤트를 MongoDB에 쌓는다.

## 평가·분석 도구

- **evaluate.py** — 클러스터 결과 + 세션 임베딩을 받아 Silhouette/Davies-Bouldin/Calinski-Harabasz와 분류 지표(F1, ROC-AUC)를 찍는다. 모델 품질 점검용.
- **analyze_semantic_debug.py** — build_session_sequences --debug 출력(JSON)을 분석. 세션 길이 분포·상위 토큰·UNKNOWN 이벤트 비율 같은 걸 콘솔·차트로 본다. 매핑 규칙 디버그용.

## 옛날 거 (초기 프로토타입, 지금 미사용)

> TransformerMLM 파이프라인으로 넘어오기 전 쓰던 실험 코드들. 현재 분류는 cluster_server.py가 맡으므로 안 쓴다.
> 
- **predict.py** — model.pkl(XGBoost)을 로드해 session_features CSV로 이탈 확률을 예측하던 초기 실험 스크립트.
- **train_model.py** — session_features CSV로 XGBClassifier를 학습해 model.pkl을 저장. predict.py와 한 쌍인 초기 실험 코드.
- **quick_start.py** — MongoDB 이벤트 → 시간 기반 세션 재구성 → Word2Vec 임베딩 → HDBSCAN → PCA 시각화를 한 파일에 담은 초기 프로토타입.

## 노트북

- **colab_pretrain_cluster.ipynb** — Colab에서 TransformerMLM 사전학습과 HDBSCAN 클러스터링을 하는 메인 노트북. colab_export_artifacts.py가 이 노트북의 마지막 export 셀 역할을 한다.

---

## 기타 테스트용 파일 - 추후 삭제 필요

- **test-sdk.js**
- **./tests/integration.test.js**

## 생성물/커밋 주의 파일

- **ml/__pycache__/** — Python 바이트코드 캐시. 커밋하지 않는 게 맞음.
- **ml/output/** — 모델·리포트·분석 결과 산출물. 운영 배포에 필요한 일부 artifact를 제외하면 보통 코드 커밋 대상은 아님.
- **ml/ml/output/**, **ml/ml/analysis/** — 과거 실행 결과/분석 이미지·CSV. 코드가 아니라 생성물.
- **.pt / .npy / .png / .pdf / 대량 csv·jsonl** — 학습/분석 산출물이라 필요한 경우 별도 공유하고, 일반 코드 커밋에서는 제외하는 쪽이 안전함.

---

### **브라우저 수집 흐름**

sdk-B / sdk-C → sdk-A → core/eventProcessor → sender → /collect

### **서버 저장/조회 흐름**

/collect → MongoDB(Event) → /api/logs | /api/classify | /api/clusters | /api/report

### **ML 연결 흐름**

classify.js → cluster_server.py

clusters.js → cluster_server.py / retrain_centroids.py / cluster_meta.json / site_snapshots

report.js → Gemini API / 로컬 fallback / report_html.py가 만든 PDF

### **학습 흐름**

MongoDB → build_session_sequences.py → prepare_transformer_input.py → train_transformer_encoder.py → cluster_session_embeddings.py → colab_export_artifacts.py → cluster_server.py


