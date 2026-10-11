# Dignolucir 기존 클러스터링 요약 및 품질 평가

## 1. 판단

**기존 결과는 일부 반복 행동 패턴을 구분하는 데 쓸 수 있지만, 전체 고객을 대표하는 운영 분석으로는 부족하다.** 정답 라벨과 동종 쇼핑몰 벤치마크가 없어 통계적으로 “업계 평균 이하”라고 판정할 수는 없다. 내부 분리도는 중간 수준의 구조를 보이며, 낮은 적용 범위와 검증 방식 때문에 개선이 필요하다는 판단이다.

평가 대상은 제공된 `cluster_results.csv` 222행과 `dignolucir_all_sessions.csv` 1,023행이다. 데이터 파일의 문구는 분석 자료로만 취급했다. 실행 시 로컬 수정본의 코드와 모델을 사용했으며, GitHub main의 미수정 코드라고 가정하지 않았다.

## 2. 데이터 범위와 분모

- 실제 CSV 기간: **2026-08-07T16:41:33.876+09:00 ~ 2026-09-10T16:16:42.825+09:00 (KST)**.
- 제공된 종료 16:14와 달리 전체 CSV는 9월 10일 **16:16:42.825**까지 포함한다. 본 보고서는 CSV 전체를 기준으로 한다.
- 전체 이벤트 **31,909개**, 세션 ID **1,023개**. 고유 고객 수는 아니다.
- 품질 필터 통과 **371개** → 동일 시퀀스 최대 5개 제한으로 **149개 제외** → 클러스터링 입력 **222개**.
- 222개 중 군집 배정 **137개(61.71%)**, 노이즈 **85개(38.29%)**. 전체 1,023개 대비 배정률은 **13.39%**.
- 원시 의미 시퀀스는 전체 **188종**, 222개 표본에서는 **142종**이다. 222개 모두 독립된 행동 패턴은 아니다.

| 품질 필터 제외 원인 | 세션 |
| --- | ---: |
| 의미 토큰 3개 미만만 해당 | 508 |
| 어휘 밖 토큰 비율 20% 초과만 해당 | 49 |
| 두 조건 모두 해당 | 95 |
| 합계 | 652 |

149개 중복 제외는 파일·코드의 시퀀스를 어휘 ID로 변환하고 `min(동일 패턴 빈도, 5)`를 합산하여 **222개**가 나오는 것으로 확인했다. 정상 반복 방문을 무효 데이터로 볼 근거는 없다. 학습 가중치 조절과 전체 세션 결과 제공은 구분해야 한다.

## 3. 군집 요약

아래 행동 빈도는 길이가 긴 세션 하나가 지배하지 않도록 **그 행동을 포함하는 세션 수**로 계산했다. 전체 CSV의 완전한 시퀀스를 사용하므로, 과거 127토큰 잘림이 있는 입력 요약과 일부 다를 수 있다.

| 군집 | 세션 | 의미 토큰 중앙값 | 주요 행동: 해당 세션 수 | 장바구니 세션 | 구매 클릭 세션 |
| --- | --- | --- | --- | --- | --- |
| -1 | 85 | 5 | VIEW_PRODUCT 55/85, SCROLL_PRODUCT 42/85, CHECK_PRICE 40/85 | 1 | 1 |
| 0 | 11 | 3 | VIEW_PRODUCT 11/11, SCROLL_CATEGORY 11/11 | 0 | 0 |
| 1 | 18 | 7 | PRICE_REVIEW_EPISODE 18/18, CHECK_PRICE 18/18, VIEW_PRODUCT 16/18 | 0 | 0 |
| 2 | 25 | 52 | VIEW_PRODUCT 25/25, SCROLL_PRODUCT 25/25, CLICK_ELEMENT 22/25 | 1 | 0 |
| 3 | 11 | 69 | VIEW_PRODUCT 11/11, SCROLL_PRODUCT 11/11, SCROLL_HOME 11/11 | 2 | 2 |
| 4 | 20 | 5 | VIEW_REVIEW 20/20, REVIEW_EXPLORATION_EPISODE 19/20, CHECK_PRICE 5/20 | 0 | 0 |
| 5 | 29 | 4 | VIEW_PRODUCT 29/29, CHECK_PRICE 29/29, SCROLL_PRODUCT 24/29 | 0 | 0 |
| 6 | 23 | 4 | VIEW_PRODUCT 23/23, SCROLL_PRODUCT 23/23, CHECK_PRICE 20/23 | 0 | 0 |

해석:

- **C0:** 카테고리에서 상품을 확인하는 짧은 패턴.
- **C1:** 가격 관련 신호를 반복하는 패턴.
- **C2:** 상품·카테고리 탐색이 길게 이어지는 패턴.
- **C3:** 호버·이미지 확대 등 다양한 상호작용이 섞인 패턴. 구매 클릭도 포함하지만 구매 완료 군집은 아니다.
- **C4:** 리뷰 관련 신호 중심의 짧은 패턴.
- **C5·C6:** 상품·가격·스크롤이 공통인 짧은 패턴. 토큰 순서·문맥 구분은 있으나 운영자가 별도 캠페인 대상으로 구분할 이유는 추가 검증이 필요하다.
- **노이즈:** 단순 오류 집합이 아니다. 장바구니 이벤트 8개 중 **4개**, 구매 클릭 6개 중 **3개**가 포함되어 중요한 행동도 분석에서 빠진다.

## 4. 재계산한 품질

동일 체크포인트로 CSV의 `[CLS]` 및 사용 토큰을 임베딩하고 L2 정규화한 후 평가했다. 저장된 PCA 2차원 좌표를 원본 임베딩 대신 사용하지 않았다. HDBSCAN `min_cluster_size=8, min_samples=3` 재실행과 기존 라벨의 **ARI=1.0000**, 시퀀스 불일치 **0개**로 재현을 확인했다.

| 지표 | 결과 | 해석 |
| --- | ---: | --- |
| 군집 수 | 7 | 노이즈 제외 |
| 실루엣, Euclidean | 0.4322 | 배정된 137개만 평가 |
| 실루엣, cosine | 0.6018 | 거리 정의가 달라 위 값과 직접 비교 불가 |
| Davies–Bouldin | 0.8743 | 같은 표현 공간에서 낮을수록 분리 유리 |
| Calinski–Harabasz | 100.1452 | 같은 데이터·표현에서 비교할 상대 지표 |
| 음수 실루엣 세션 | 1 / 137 | 배정된 표본 내부 혼동은 작음 |
| 그룹 재표집 ARI 평균 | 0.7810 | 아래의 실제 재학습 안정성 진단 |
| 그룹 재표집 ARI 10~90백분위 | 0.6384 ~ 0.9265 | 신뢰구간이 아니라 반복 실험 분포 |

실루엣은 정답 정확도가 아니다. 노이즈를 제거한 뒤 남은 조밀한 표본만 계산하므로 높은 값과 낮은 적용 범위가 함께 나타날 수 있다. 보편적인 “평균 점수” 기준도 없다. [실루엣 공식 문서](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.silhouette_score.html).

## 5. 코드와 데이터에서 확인한 문제

### 5.1 일부 표본과 낡은 지표가 전체 품질처럼 보일 수 있음

[`retrain_centroids.py:196`](../../retrain_centroids.py#L196)의 `compute_quality_metrics`는 노이즈를 제외한다. 이 계산 자체는 가능하지만 전체 배정률과 함께 보여야 한다. `cluster_meta.json`의 최신 `cluster_quality.noise_rate`는 **0.3829**인데 최상위 `noise_ratio`는 **0.2424**로 남아 있다. 최상위 CH도 **83.06**이지만 재계산은 **100.1452**이다. 재학습 저장 구간에서 일부 필드만 갱신하는 것이 원인이다.

`cluster_summary.txt`는 **294개 세션과 synth-* 세션**을 포함한 과거 결과이다. 이번 222개 결과의 요약으로 사용할 수 없다. 이것이 현재 222개에 합성 세션이 섞였다는 뜻은 아니다.

### 5.2 어휘 밖 조합과 중복 제한으로 적용 범위 축소

[`retrain_centroids.py:101`](../../retrain_centroids.py#L101)는 토큰 수 3개 미만 또는 OOV 비율 20% 초과를 제외하고, 동일 ID 시퀀스를 5개로 제한한다. `BOARD|START_SESSION|NONE`, `BOARD|EXIT_BOUNCE|NONE`, `CATEGORY|VIEW_REVIEW|DWELL_SHORT`처럼 페이지와 행동의 새 조합도 OOV가 된다. OOV는 불량 고객 행동이라는 뜻이 아니다.

최대 5개 제한은 중복 지배를 완화하지만 여전히 같은 패턴의 반복이 HDBSCAN 밀도를 키울 수 있다. 또한 DB 조회 순서대로 먼저 5개를 고르므로 대표 세션 선택은 조회 순서에 의존한다. 개선에서는 고유 패턴을 한 번씩 학습하고 모든 일치 세션에 결과를 복원한다.

### 5.3 잘림·평균 pooling·행동 신호의 차이

[`retrain_centroids.py:76`](../../retrain_centroids.py#L76)는 마지막 **127개 토큰**과 `[CLS]`를 사용한다. 실제 **4개 세션에서 672개 토큰**이 제외됐다. 앞부분의 상품 탐색·구매 관련 맥락이 사라질 가능성이 있으나 개별 인과효과를 검증한 것은 아니다.

`SessionTransformerEncoder.encode`는 위치 정보를 거친 토큰 표현을 평균낸다. 순서를 완전히 무시하는 모델은 아니지만, 긴 복합 행동과 짧은 반복 행동을 같은 벡터 하나로 압축한다. 이번 입력 중 세션·탭·비활성 계열은 **775/3776 토큰**이다. 시작·종료·탭 활동만 있는 **10개 세션**도 기존 품질 필터를 통과했다.

### 5.4 안정성 1.0과 gate precision은 실제 정확도 검증이 아님

[`compute_profile_stability`](../../retrain_centroids.py#L231)는 상위 행동·페이지 집합의 최대 Jaccard 일치도다. 실제 세션 배정의 재표집 안정성이나 새 고객 예측 정확도를 측정하지 않는다. 같은 산출물로 다시 실행하면 1.0이 나올 수 있다.

[`calibrate_inference_gate`](../../retrain_centroids.py#L303)는 동일 학습 표본의 HDBSCAN 정상/노이즈 라벨로 centroid gate를 조정한다. 이번 gate 수락 **126개**, 이 중 HDBSCAN 비노이즈 **120개**, 정확한 군집 ID까지 일치 **120개**다. `estimated_precision=0.9524`는 구매 예측 정확도도, 독립 검증 정확도도 아니다.

### 5.5 수신 시간과 의미 이벤트의 한계

[`export_all_sessions_csv.py`](../../export_all_sessions_csv.py)는 `received_at` 최솟값·최댓값 차이를 duration으로 저장한다. **710개(69.40%)의 0초**는 같은 배치 수신 시각일 수 있으므로 실제 0초 체류로 볼 수 없다. 이번 개선의 학습 특징에서 이 시간은 제외했다.

세션당 START_SESSION 복수 **45개**, 수신 시간 범위 30분 초과 **19개**, 최대 약 **22.41시간**이다. SDK가 페이지 재로드 때 시작 이벤트를 다시 보낼 수 있어 복수 시작이 곧 중복 세션 오류라는 뜻은 아니다. 원시 이벤트 시각·탭 구분이 없는 CSV만으로 세션을 임의 분할하지 않았다.

`semantic_event_mapper.py`는 섹션 재방문·호버·체류도 VIEW_REVIEW 등으로 매핑한다. 직접 리뷰 계열 원시 이벤트는 **13개(모두 review_scroll)**뿐이다. 군집의 “리뷰”는 관련 신호로 표현해야 하며 실제 정독·구매 의도를 확정할 수 없다. `guest_purchase`도 CLICK_BUY로 매핑되는 버튼 행동이다. 제공 이벤트에 purchase_success/purchase_complete는 없으므로 구매 전환율은 계산하지 않았다.

## 6. 권고

기존 결과를 폐기하기보다는 반복 행동 탐색용 기준선으로 보관하고, 전체 적용 범위·실제 재표집 안정성·독립 주문 전환 검증을 보강해야 한다. 개선 실험과 반대 근거는 [개선 보고서](advanced_clustering_report.md)에 기재했다. 운영 코드·원본 모델 파일·DB는 이번 분석에서 변경하지 않았다.

## 7. 재현 자료와 출처

수치 원본: `advanced_analysis/data_audit.json`, `baseline_metrics.json`, `validation.json`. 입력 SHA-256은 data_audit.json에 보관했다. 재현 스크립트는 `ml/advanced_clustering.py`, `ml/write_clustering_reports.py`다.

- [실루엣 정의와 범위](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.silhouette_score.html): 같은 거리 공간에서 비교하며, 정답 정확도가 아니다.
- [군집 평가 지표와 알고리즘 특성](https://scikit-learn.org/stable/modules/clustering.html#clustering-performance-evaluation): 분리도·밀도·군집 형태에 따라 지표 해석이 달라진다.
- [ARI 정의](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.adjusted_rand_score.html): 라벨 번호 순서와 무관한 배정 일치도이며 우연 일치를 보정한다.
- [HDBSCAN 파라미터 선택](https://hdbscan.readthedocs.io/en/latest/parameter_selection.html): 최소 군집 크기와 밀도 조건이 노이즈·군집 수에 영향을 준다.
- [계층적 군집화](https://scikit-learn.org/stable/modules/generated/sklearn.cluster.AgglomerativeClustering.html): 이번 비교에 Ward·average 연결을 포함했다.

