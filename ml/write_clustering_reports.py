"""Finalize offline audit reports and CSV intermediate after advanced_clustering.py."""
import advanced_clustering as c
import platform
from collections import Counter
import numpy as np
import pandas as pd
from sklearn.metrics import adjusted_rand_score, pairwise_distances
from threadpoolctl import threadpool_limits
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import json

OUT = c.OUT
ROOT = c.HERE / 'output/clustering'
load = lambda name: json.loads((OUT/name).read_text(encoding='utf-8'))
f, audit = load('final_metrics.json'), load('data_audit.json')
base = pd.read_csv(c.BASE_FILE)
rows = pd.read_csv(OUT/'advanced_results_intermediate.csv')
all_rows = pd.read_csv(c.ALL_FILE)
joined = all_rows.set_index('session_id').loc[base.session_id].reset_index()
B = np.load(OUT/'baseline_embeddings.npy')
features = np.load(OUT/'advanced_features.npz')
F, U, AA = features['reference'],features['unique'],features['full']
ay = features['reference_labels']
spec = f['selected']['spec']


def summary(values):
    return dict(mean=float(np.mean(values)),p10=float(np.quantile(values,.1)),
                p90=float(np.quantile(values,.9)),values=values)


def probes():
    reps = joined.drop_duplicates('semantic_sequence').sort_values('semantic_sequence').index.to_numpy()
    groups = joined.semantic_sequence.to_numpy()
    rng = np.random.default_rng(c.SEED+7)
    old_ari, new_ari = [], []
    for _ in range(30):
        chosen = np.sort(rng.choice(reps,int(.8*len(reps)),replace=False))
        chosen_patterns = set(groups[chosen])
        old_ix = np.array([i for i,g in enumerate(groups) if g in chosen_patterns])
        yo = c.fit_model(B[old_ix],dict(algorithm='hdbscan',min_cluster_size=8,min_samples=3))
        omap = dict(zip(groups[old_ix],yo))
        old_ari.append(adjusted_rand_score(base.cluster.iloc[chosen], [omap[g] for g in groups[chosen]]))
        train = joined.iloc[chosen]
        train = train[train.semantic_sequence.map(c.informative)]
        fe = c.Features(f['selected']['mode'])
        X = fe.fit_transform(train)
        yn = c.fit_model(X,spec)
        nmap = dict(zip(train.semantic_sequence,yn))
        new_ari.append(adjusted_rand_score(ay[chosen],[nmap.get(g,-2) for g in groups[chosen]]))
    cent = np.load(c.HERE/'output/unsupervised_semantic/cluster_centroids.npy')
    cent = c.normalize(cent)
    sims = B @ cent.T
    meta = json.loads(c.META_FILE.read_text(encoding='utf8'))
    gate = meta['inference_quality_gate']
    gap = np.sort(sims,axis=1)[:,-1]-np.sort(sims,axis=1)[:,-2]
    accept = (sims.max(axis=1)>=gate['min_similarity']) & (gap>=gate['min_margin'])
    labels = base.cluster.to_numpy()
    diag = dict(
        baseline_group_stability=summary(old_ari),advanced_group_stability=summary(new_ari),
        protocol='30 repeats, same 80% of 142 original unique sequence groups; score each group once; old HDBSCAN refits retained duplicate rows, new TF-IDF and KMeans both refit informative unique patterns; noise/insufficient retained in ARI',
        baseline_unique_metrics=c.score(B[reps],labels[reps]),
        gate_accepted=int(accept.sum()),gate_nonnoise=int((accept & (labels>=0)).sum()),
        gate_exact_cluster_match=int((accept & (sims.argmax(axis=1)==labels)).sum()),
        lifecycle_tokens=sum(t[1] in c.LIFECYCLE for seq in base.sequence for t in c.parse_tokens(seq)),
        used_tokens=sum(len(c.parse_tokens(seq)) for seq in base.sequence),
        model_input_dimension=int(F.shape[1]),
        reference_informative=int((ay>=0).sum()),
        paired_negative_change=None,
        versions=dict(python=platform.python_version(),numpy=np.__version__,pandas=pd.__version__,
                      sklearn=__import__('sklearn').__version__,torch=__import__('torch').__version__))
    c.dump('validation.json',diag)
    return diag


def table(headers,data):
    return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |'] +
                     ['| '+' | '.join(str(x).replace('|',' / ') for x in row)+' |' for row in data])


def profile(data, label_col):
    result=[]
    for cid,g in data.groupby(label_col):
        counts=Counter(a for s in g.semantic_sequence for a in set(t[1] for t in c.parse_tokens(s) if t[1] not in c.LIFECYCLE))
        result.append([int(cid),len(g),f'{g.semantic_token_count.median():.0f}',
                       ', '.join(f'{a} {n}/{len(g)}' for a,n in counts.most_common(3)),
                       int((g.cart_count>0).sum()),int((g.purchase_click_count>0).sum())])
    return result


def make_plot():
    common = base.cluster>=0
    coords = c.PCA(n_components=2,random_state=c.SEED).fit_transform(F)
    fig,axes=plt.subplots(1,3,figsize=(15,4.8),constrained_layout=True)
    for ax,y,title in [(axes[0],base.cluster.to_numpy(),'Original: 7 clusters, 85 unassigned'),
                       (axes[1],ay,'Advanced: 4 clusters, 10 insufficient')]:
        for cid in sorted(set(y)):
            mask=y==cid
            ax.scatter(coords[mask,0],coords[mask,1],s=20,alpha=.75,
                       color='#aaaaaa' if cid<0 else plt.get_cmap('tab10')(int(cid)),label=str(cid))
        ax.set_title(title,fontsize=11);ax.set_xlabel('PC1');ax.set_ylabel('PC2')
        ax.legend(title='Cluster',fontsize=8,ncol=2)
    metrics=['Assigned / all 1,023','Assigned / reference 222']
    x=np.arange(2)
    axes[2].bar(x-.18,[137/1023,137/222],.36,label='Original',color='#49648c')
    axes[2].bar(x+.18,[361/1023,212/222],.36,label='Advanced',color='#e49b47')
    axes[2].set_xticks(x,metrics,fontsize=8);axes[2].set_ylim(0,1.08)
    axes[2].set_ylabel('Fraction');axes[2].legend();axes[2].set_title('Coverage; abstentions retained',fontsize=11)
    fig.suptitle('Same 222 sessions projected into the same semantic feature space (visualization only)',fontsize=12)
    fig.savefig(OUT/'clustering_comparison.png',dpi=160)
    plt.close(fig)


def write_reports(d):
    plot_variance = float(c.PCA(n_components=2, random_state=c.SEED).fit(F).explained_variance_ratio_.sum())
    names={-2:'행동 근거 부족',-1:'기준 밖 또는 배정 불확실',0:'리뷰 관련 신호 중심',
           1:'상품·가격 확인 중심',2:'다양한 상호작용·구매 시도 포함',3:'상품·카테고리 반복 탐색'}
    rows['cluster_label']=rows.cluster.map(names)
    rows['in_reference_222']=rows.session_id.isin(set(base.session_id))
    # Do not equate guest-purchase button events with completed purchases.
    rows['has_cart_event']=rows.cart_count>0
    rows['has_purchase_intent_event']=(rows.purchase_click_count>0)|(rows.guest_purchase_count>0)
    rows['has_explicit_review_event']=rows.review_count>0
    event_counts=rows.event_type_counts.map(json.loads)
    rows['confirmed_purchase_event_count']=event_counts.map(lambda x:x.get('purchase_success',0)+x.get('purchase_complete',0))
    rows.to_csv(OUT/'advanced_results_intermediate.csv',index=False,encoding='utf-8-sig')
    assert len(rows)==1023 and rows.session_id.is_unique
    assert rows.event_count.sum()==31909
    assert (rows.cluster>=0).sum()==361
    assert (ay>=0).sum()==212
    assert set(rows.session_id)==set(all_rows.session_id)
    assert rows.confirmed_purchase_event_count.sum()==0
    old_headers=['군집','세션','의미 토큰 중앙값','주요 행동: 해당 세션 수','장바구니 세션','구매 클릭 세션']
    baseline_table=table(old_headers,profile(joined,'cluster'))
    new_table=table(['군집','이름','전체 세션','222개 기준 세션','장바구니 이벤트','구매 클릭 이벤트'],[
        [cid,names[cid],int((rows.cluster==cid).sum()),int((ay==cid).sum()),
         int(rows.loc[rows.cluster==cid,'cart_count'].sum()),int(rows.loc[rows.cluster==cid,'purchase_click_count'].sum())]
        for cid in [0,1,2,3,-2,-1]])
    q=f['baseline_in_bert']; cf=f['common_assigned_baseline_features']; cn=f['common_assigned_advanced_features']
    old_st=d['baseline_group_stability'];new_st=d['advanced_group_stability']
    sources='''
- [실루엣 정의와 범위](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.silhouette_score.html): 같은 거리 공간에서 비교하며, 정답 정확도가 아니다.
- [군집 평가 지표와 알고리즘 특성](https://scikit-learn.org/stable/modules/clustering.html#clustering-performance-evaluation): 분리도·밀도·군집 형태에 따라 지표 해석이 달라진다.
- [ARI 정의](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.adjusted_rand_score.html): 라벨 번호 순서와 무관한 배정 일치도이며 우연 일치를 보정한다.
- [HDBSCAN 파라미터 선택](https://hdbscan.readthedocs.io/en/latest/parameter_selection.html): 최소 군집 크기와 밀도 조건이 노이즈·군집 수에 영향을 준다.
- [계층적 군집화](https://scikit-learn.org/stable/modules/generated/sklearn.cluster.AgglomerativeClustering.html): 이번 비교에 Ward·average 연결을 포함했다.
'''
    baseline_report=f'''# Dignolucir 기존 클러스터링 요약 및 품질 평가

## 1. 판단

**기존 결과는 일부 반복 행동 패턴을 구분하는 데 쓸 수 있지만, 전체 고객을 대표하는 운영 분석으로는 부족하다.** 정답 라벨과 동종 쇼핑몰 벤치마크가 없어 통계적으로 “업계 평균 이하”라고 판정할 수는 없다. 내부 분리도는 중간 수준의 구조를 보이며, 낮은 적용 범위와 검증 방식 때문에 개선이 필요하다는 판단이다.

평가 대상은 제공된 `cluster_results.csv` 222행과 `dignolucir_all_sessions.csv` 1,023행이다. 데이터 파일의 문구는 분석 자료로만 취급했다. 실행 시 로컬 수정본의 코드와 모델을 사용했으며, GitHub main의 미수정 코드라고 가정하지 않았다.

## 2. 데이터 범위와 분모

- 실제 CSV 기간: **{audit['start']} ~ {audit['end']} (KST)**.
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

{baseline_table}

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
| 실루엣, Euclidean | {q['silhouette']:.4f} | 배정된 137개만 평가 |
| 실루엣, cosine | {q['silhouette_cosine']:.4f} | 거리 정의가 달라 위 값과 직접 비교 불가 |
| Davies–Bouldin | {q['db']:.4f} | 같은 표현 공간에서 낮을수록 분리 유리 |
| Calinski–Harabasz | {q['ch']:.4f} | 같은 데이터·표현에서 비교할 상대 지표 |
| 음수 실루엣 세션 | 1 / 137 | 배정된 표본 내부 혼동은 작음 |
| 그룹 재표집 ARI 평균 | {old_st['mean']:.4f} | 아래의 실제 재학습 안정성 진단 |
| 그룹 재표집 ARI 10~90백분위 | {old_st['p10']:.4f} ~ {old_st['p90']:.4f} | 신뢰구간이 아니라 반복 실험 분포 |

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

`SessionTransformerEncoder.encode`는 위치 정보를 거친 토큰 표현을 평균낸다. 순서를 완전히 무시하는 모델은 아니지만, 긴 복합 행동과 짧은 반복 행동을 같은 벡터 하나로 압축한다. 이번 입력 중 세션·탭·비활성 계열은 **{d['lifecycle_tokens']}/{d['used_tokens']} 토큰**이다. 시작·종료·탭 활동만 있는 **10개 세션**도 기존 품질 필터를 통과했다.

### 5.4 안정성 1.0과 gate precision은 실제 정확도 검증이 아님

[`compute_profile_stability`](../../retrain_centroids.py#L231)는 상위 행동·페이지 집합의 최대 Jaccard 일치도다. 실제 세션 배정의 재표집 안정성이나 새 고객 예측 정확도를 측정하지 않는다. 같은 산출물로 다시 실행하면 1.0이 나올 수 있다.

[`calibrate_inference_gate`](../../retrain_centroids.py#L303)는 동일 학습 표본의 HDBSCAN 정상/노이즈 라벨로 centroid gate를 조정한다. 이번 gate 수락 **{d['gate_accepted']}개**, 이 중 HDBSCAN 비노이즈 **{d['gate_nonnoise']}개**, 정확한 군집 ID까지 일치 **{d['gate_exact_cluster_match']}개**다. `estimated_precision=0.9524`는 구매 예측 정확도도, 독립 검증 정확도도 아니다.

### 5.5 수신 시간과 의미 이벤트의 한계

[`export_all_sessions_csv.py`](../../export_all_sessions_csv.py)는 `received_at` 최솟값·최댓값 차이를 duration으로 저장한다. **710개(69.40%)의 0초**는 같은 배치 수신 시각일 수 있으므로 실제 0초 체류로 볼 수 없다. 이번 개선의 학습 특징에서 이 시간은 제외했다.

세션당 START_SESSION 복수 **45개**, 수신 시간 범위 30분 초과 **19개**, 최대 약 **22.41시간**이다. SDK가 페이지 재로드 때 시작 이벤트를 다시 보낼 수 있어 복수 시작이 곧 중복 세션 오류라는 뜻은 아니다. 원시 이벤트 시각·탭 구분이 없는 CSV만으로 세션을 임의 분할하지 않았다.

`semantic_event_mapper.py`는 섹션 재방문·호버·체류도 VIEW_REVIEW 등으로 매핑한다. 직접 리뷰 계열 원시 이벤트는 **13개(모두 review_scroll)**뿐이다. 군집의 “리뷰”는 관련 신호로 표현해야 하며 실제 정독·구매 의도를 확정할 수 없다. `guest_purchase`도 CLICK_BUY로 매핑되는 버튼 행동이다. 제공 이벤트에 purchase_success/purchase_complete는 없으므로 구매 전환율은 계산하지 않았다.

## 6. 권고

기존 결과를 폐기하기보다는 반복 행동 탐색용 기준선으로 보관하고, 전체 적용 범위·실제 재표집 안정성·독립 주문 전환 검증을 보강해야 한다. 개선 실험과 반대 근거는 [개선 보고서](advanced_clustering_report.md)에 기재했다. 운영 코드·원본 모델 파일·DB는 이번 분석에서 변경하지 않았다.

## 7. 재현 자료와 출처

수치 원본: `advanced_analysis/data_audit.json`, `baseline_metrics.json`, `validation.json`. 입력 SHA-256은 data_audit.json에 보관했다. 재현 스크립트는 `ml/advanced_clustering.py`, `ml/write_clustering_reports.py`다.
{sources}
'''
    winners=load('experiments.json')['winners']
    experiment_table=table(['표현','선택 알고리즘','개발 실루엣','개발 ARI','보류 패턴 실루엣'],[
        [m, f"{v['spec']['algorithm']} k={v['spec'].get('k','-')}",f"{v['development']['silhouette']:.4f}",
         f"{v['stability']['mean']:.4f}",f"{v['holdout']['silhouette']:.4f}"] for m,v in winners.items()])
    advanced_report=f'''# Dignolucir 개선 클러스터링 결과 및 품질 평가

## 1. 결과와 적용 범위

**행동·페이지·행동 전이를 분리한 TF-IDF와 K-means(k=4)를 적용했다.** 중복 패턴은 한 번만 학습하고 동일 패턴의 모든 세션에 복원한다. 결과는 [advanced_cluster_results.csv](advanced_cluster_results.csv)에 **전체 1,023개 세션을 한 행씩** 보존한다.

- 기존 222개 기준: **137 → 212개 배정**, 85개 노이즈 중 **75개 복구**, 나머지 **10개는 행동 근거 부족**으로 표시.
- 전체 1,023개 기준: **137 → 361개 배정(13.39% → 35.29%)**. 추가 224개는 기존 노이즈 75개와 중복 제한으로 빠졌던 149개이다.
- 분석 결과에서는 **614개를 행동 근거 부족**, **48개를 기준 패턴 밖 또는 배정 불확실**로 유지해 신뢰도 기준을 보존한다.
- 48개의 새로운 패턴 세션은 이번 거리·margin gate에서 모두 보류됐다. 따라서 이번 실행에서 **OOV 세션 복구 성과를 입증한 것은 아니다**.

### 운영 대시보드 적용 방식

운영 화면에서는 분석용 보류 상태를 미분류로 숨기지 않는다. 4개 행동 군집과 `짧은 방문·행동 정보 부족형`을 합쳐 최대 5개 유형으로 전체 1,023세션을 배정한다. 행동 근거가 충분한 기존 패턴 361세션은 `신뢰 높음`, 정보 부족 614세션과 유형 경계가 모호한 48세션은 `신뢰 낮음`으로 별도 표시한다. 모호한 48세션은 가장 가까운 행동 군집에 포함하지만 확정적인 고객 의도로 해석하지 않는다.

개선된 점은 **해석 가능한 표현에서의 분리도, 적용 범위, 그룹 재학습 안정성**이다. 기존 BERT 공간의 분리도는 오히려 낮아졌다. 전 영역에서 우월한 모델 또는 운영 정확도 향상으로 주장하지 않는다.

## 2. 개선 파이프라인

1. 두 CSV를 session_id로 결합하고 ID 유일성·31,909 이벤트 합계를 검증했다. 원본은 수정하지 않았다.
2. 의미 토큰 3개 이상이면서 시작·종료·탭·비활성 외 행동이 최소 1개 있는 세션을 학습 가능으로 정의했다. 이 기준도 정답 품질 판정은 아니다.
3. 222개 중 212개, 고유 패턴 **135개**를 학습한다. 같은 패턴이 5번 나타나도 학습 가중치는 한 번이다.
4. 시퀀스 전체를 사용한다. `[CLS]`·세션 시작/종료·탭·비활성 토큰은 특징에서 제외한다. 가격·리뷰·상품·이미지·옵션 등의 행동은 유지한다.
5. `행동 unigram 65% + 페이지 15% + 인접 행동 전이 20%` 블록을 구성한다. 각 블록은 sublinear TF(1+log count), IDF, L2 정규화 후 **가중치 제곱근**을 곱해 연결하고 다시 정규화한다. 총 **{d['model_input_dimension']}차원**이다. 수치는 이 실험의 고정 설계 선택이며 보편 최적 가중치가 아니다.
6. 전이는 연속 동일 행동을 압축한 후 `행동A>행동B`로 만든다. 전체 문맥 토큰 조합 대신 요소를 분리해 어휘 조합 의존성을 줄인다. 기존 raw 이벤트의 정확성을 새로 검증한 것은 아니다.
7. 개발 비교에서 선택한 K-means(k=4), `n_init=30`, seed={c.SEED}를 고정한 뒤 모든 고유 패턴으로 다시 학습한다.
8. 기준 패턴과 완전히 같으면 군집을 복원한다. 새 패턴은 가장 가까운 centroid를 후보로 삼되 군집 학습 거리의 95백분위 이내이고 상대 거리 margin≥0.05일 때만 배정한다. 이는 설명 가능한 보류 규칙이며 확률 보정된 신뢰구간이 아니다.

원시 이벤트 빈도·장바구니·구매 클릭·서버 수신 시간은 **모델 선택용 정답이나 특징에 넣지 않고** 사후 해석용으로 보존했다. 다만 의미 시퀀스에 ADD_CART·CLICK_BUY 등은 포함되므로 구매 의도 집중도가 독립적인 외부 검증은 아니다.

## 3. 탐색 및 검증 설계

3개 표현(BERT, 완전 토큰 TF-IDF, 분리 TF-IDF) × 22개 설정, **총 66개 후보**를 비교한다. 알고리즘은 K-means, Ward, average-linkage, HDBSCAN, DBSCAN이다.

- K-means·Ward·average: k=2~5.
- HDBSCAN: min_cluster_size=5/8/12 × min_samples=2/4.
- DBSCAN: eps=0.3/0.5/0.7/0.9, min_samples=3.
- 개발 후보 조건: 배정률≥85%, 군집 2개 이상, 최소 고유 패턴 5개, 최대 군집 비중≤80%, 10회 80% 재표집 ARI 평균≥0.75.
- 위 조건을 통과한 후보 중 **각 표현 내부**에서 개발 실루엣이 가장 큰 설정을 선택했다. 0.75 등의 기준은 이번 운영 용도에 설정한 조건이지 업계 평균이 아니다.
- 개선 목적이 반복 문맥·수명주기 영향 완화와 행동 해석이므로 최종 표현은 분리 TF-IDF를 채택했다. BERT 후보보다 모든 점수가 높아서 선택한 것은 아니다.

{experiment_table}

개발 101개/보류 34개는 **서로 다른 완전 시퀀스 그룹**으로 분리했다. TF-IDF의 IDF·어휘는 개발 데이터만으로 구성하여 보류 데이터를 변환했다. 보류 라벨은 개발 centroid로 배정한 것이며, 그 단계에는 거리 gate를 사용하지 않았다.

**한계:** 첫 시도에서 수명주기만 있는 패턴의 군집을 확인한 후 학습 자격 규칙을 수정했다. 따라서 보류 결과도 이번 탐색 과정의 진단으로 봐야 하며 완전히 손대지 않은 외부 테스트 성적으로 간주할 수 없다. 또한 기존 BERT 사전학습이 이 패턴을 보았는지는 확인할 수 없어 BERT 후보의 보류 성적은 encoder 수준의 독립 검증이 아니다.

## 4. 공정한 품질 비교

분리도는 **기존에 군집이 배정된 동일 137개 세션**을 공통 평가 집합으로 사용한다. 양쪽이 같은 거리 공간을 쓰는 표만 직접 비교한다. 군집 수가 7→4로 줄어들어 운영 분류의 세밀함도 달라졌다.

| 공통 137개, 분리 TF-IDF 공간 | 기존 7군집 | 개선 4군집 |
| --- | ---: | ---: |
| Euclidean 실루엣 | {cf['silhouette']:.4f} | {cn['silhouette']:.4f} |
| Davies–Bouldin | {cf['db']:.4f} | {cn['db']:.4f} |
| 음수 실루엣 비율 | {cf['negative_fraction']:.2%} | {cn['negative_fraction']:.2%} |

| 공통 137개, 기존 BERT 공간 | 기존 7군집 | 개선 4군집 |
| --- | ---: | ---: |
| Euclidean 실루엣 | {q['silhouette']:.4f} | {f['common_assigned_advanced_bert']['silhouette']:.4f} |
| Davies–Bouldin | {q['db']:.4f} | {f['common_assigned_advanced_bert']['db']:.4f} |

**새 표현 공간에서는 좋아졌지만 BERT 공간에서는 악화됐다.** 새 표현을 설계한 뒤 그 공간에서 평가한 결과이므로 외부 사업 성과 개선으로 확대 해석하지 않는다.

| 적용 범위별 개선 결과 | 배정 수 | 실루엣: 분리 TF-IDF |
| --- | ---: | ---: |
| 기존 222개 중 배정 | 212 | {f['advanced_in_advanced']['silhouette']:.4f} |
| 고유 학습 패턴 | 135 | {f['unique_pattern_metrics']['silhouette']:.4f} |
| 전체 1,023개 중 배정 | 361 | {f['full_metrics']['silhouette']:.4f} |

361개 점수가 높은 이유에는 동일 패턴 149개 복원이 포함된다. 이를 212개 점수보다 일반화 성능이 높아졌다는 근거로 쓰지 않는다. 정보 부족·보류 세션은 위 실루엣 계산에서 제외되지만 CSV에는 모두 남아 있다.

### 실제 재학습 안정성

같은 142개 원본 고유 패턴에서 80%를 뽑는 실험을 30회 반복했다. 기존 방법은 해당 그룹의 원래 중복 행을 유지해 HDBSCAN을 재학습한다. 개선 방법은 행동이 있는 고유 패턴만 사용해 **TF-IDF와 K-means를 둘 다 다시 학습**한다. 선택된 그룹마다 한 표로 ARI를 계산하고, 노이즈·정보 부족 상태도 포함한다. 각 방법의 전체 학습 결과에 대한 안정성이므로 두 방법의 라벨 자체를 정답처럼 비교한 것은 아니다.

| 그룹 재학습 ARI | 기존 | 개선 |
| --- | ---: | ---: |
| 평균 | {old_st['mean']:.4f} | {new_st['mean']:.4f} |
| 10백분위 | {old_st['p10']:.4f} | {new_st['p10']:.4f} |
| 90백분위 | {old_st['p90']:.4f} | {new_st['p90']:.4f} |

별도로 특징을 고정한 135개 패턴 재표집 ARI 평균은 **{f['unique_pattern_stability']['mean']:.4f}**이다. 특징 재학습을 포함하는 표 위 수치를 우선 해석한다. ARI는 정확도가 아니라 반복 배정 안정성이다. [ARI 공식 문서](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.adjusted_rand_score.html).

임의로 군집 크기를 유지한 라벨 순열 100회의 실루엣 평균은 {f['permutation_reference']['mean']:.4f}, 95백분위는 {f['permutation_reference']['p95']:.4f}였다. 군집 구조가 무작위보다는 분명하다는 기술적 참고이며, 후보 탐색 이후의 유의확률이나 외부 검증은 아니다.

## 5. 새로운 군집과 활용

{new_table}

- **C0 리뷰 관련 신호 중심:** 리뷰로 매핑된 재방문·체류를 주로 포함한다. 직접 리뷰 이벤트나 구매 완료를 의미하지 않는다. 리뷰 UI 개선 가설을 세운 뒤 실제 이벤트·화면과 대조한다.
- **C1 상품·가격 확인 중심:** 기존 C1·C5·C6 등의 유사한 탐색 행동을 더 큰 운영 유형으로 정리한다. 가격·배송·옵션 정보 노출을 검토할 수 있으나 “가격 때문에 이탈”했다고 확정하지 않는다.
- **C2 다양한 상호작용·구매 시도 포함:** 장바구니 이벤트 8개, 구매 클릭 6개, 비회원 구매 버튼 이벤트 1개가 이 군집에 모였다. 구매자·전환 완료 집단이라는 이름을 사용하지 않는다. 장바구니·결제 시작 후 경로 점검 우선 대상이다.
- **C3 상품·카테고리 반복 탐색:** 상품·스크롤·카테고리 이동이 반복된다. 상품 비교 지원이나 탐색 동선을 검토하는 가설에 활용한다.
- **-2/-1:** 고객 유형이 아닌 보류 상태다. 이탈자·봇·비구매자로 간주하지 않는다.

![동일 표본 비교 및 배정 범위](advanced_analysis/clustering_comparison.png)

두 산점도는 동일 222개와 동일 특징 PCA를 사용한다. 2차원은 특징 분산의 **{plot_variance:.1%}**만 설명하며, 그림의 모양을 실루엣 계산의 대체물로 사용하지 않는다. CSV 좌표는 고유 패턴 135개에 fit한 별도 PCA이므로 이 그림의 좌표와 구분한다.

## 6. CSV 사용법

CSV는 UTF-8 BOM, 1,023행이며 원본 세션 ID·기간·원시 이벤트 집계·완전 시퀀스를 보존한다.

| 컬럼 | 의미 |
| --- | --- |
| cluster | 새 군집 0~3, -2=행동 근거 부족, -1=기준 밖/불확실 |
| cluster_label | 집계 행동을 근거로 붙인 설명용 이름 |
| in_reference_222 | 기존 222개 비교 표본 포함 여부 |
| original_cluster / original_cluster_probability | 기존 값 보존. 기존 값이 없던 세션은 빈 값 |
| assignment_status | reference_fit / exact_pattern_transfer / insufficient_behavior / out_of_reference_or_ambiguous |
| centroid_distance | 새 특징 공간에서 가장 가까운 중심까지 Euclidean 거리 |
| distance_margin | (두 번째 거리−첫 번째 거리)/두 번째 거리. 확률 아님 |
| has_cart_event / has_purchase_intent_event | 원시 이벤트에 근거한 부가 표식 |
| confirmed_purchase_event_count | 제공 데이터의 purchase_success/purchase_complete 합계. 모두 0이며 실제 미구매 확정이 아님 |
| sequence / semantic_sequence | 전체 의미 시퀀스. 이번에는 127토큰으로 자르지 않음 |
| original_length / used_length | 완전 시퀀스 토큰 수. 같으며 모델은 해당 시퀀스에서 특징을 추출 |
| pca_x / pca_y | 새 특징의 시각화용 좌표. 기존 CSV 좌표와 축이 다름 |

K-means에는 기존 HDBSCAN의 membership probability와 같은 값이 없으므로 새 `probability`를 만들어 채우지 않았다. `original_cluster_probability`도 정답 확률로 해석하지 않는다. 운영 `/api/classify`와 모델 형식이 다르므로 이 CSV를 복사하는 것만으로 운영 모델이 교체되지는 않는다.

## 7. 후속 개선 우선순위

1. 원시 event timestamp와 탭·페이지 단위로 세션 품질을 점검한다. CSV의 수신 시각만으로 체류 시간·세션 경계를 교정할 수 없다.
2. BOARD/CATEGORY 관련 새 조합 48개 보류를 검토하고, 도메인별 페이지·행동 매핑을 검증한 뒤 학습 범위를 확장한다. threshold만 낮춰 강제 배정하지 않는다.
3. 주문 완료를 서버 주문 데이터와 연결하고 전문가가 대표 세션을 검토한다. 구매 클릭과 완료를 분리해 실제 활용 타당성을 검증한다.
4. 다음 기간 데이터를 별도 고정 테스트로 보관한다. 독립된 시간 구간의 안정성·사업 성과를 확인한 후 운영 적용을 판단한다.
5. AI agent는 대표 세션의 설명·이름·가설 작성 보조로 사용할 수 있다. 정답 라벨을 임의로 생성해 “정확도 향상”을 주장하는 용도로는 사용하지 않는다. 이번 군집은 재현 가능한 수치 알고리즘으로 생성했다.

## 8. 재현 및 산출물

```powershell
python ml/advanced_clustering.py --deps C:/ghostTracker/.analysis-deps
python ml/write_clustering_reports.py --deps C:/ghostTracker/.analysis-deps
```

Python 분석 CSV intermediate를 Artifact Tool에서 읽어 최종 CSV로 내보냈다. 코드만 재실행할 때는 `advanced_analysis/advanced_results_intermediate.csv`에 동일 분석 값이 생성된다. 패키지 버전: {d['versions']}.

`advanced_analysis/`에는 66개 후보 결과(experiments.json), split.json, final_metrics.json, validation.json, 입력 해시(data_audit.json), 임베딩·특징 배열과 advanced_model.json을 보관한다. 원본 CSV·운영 centroid·체크포인트·DB는 변경하지 않았다. 결과 파일의 재실행 후 무결성 검증을 통과했다.

{sources}
'''
    (ROOT/'clustering_quality_report.md').write_text(baseline_report,encoding='utf-8')
    (ROOT/'advanced_clustering_report.md').write_text(advanced_report,encoding='utf-8')
    c.dump('cluster_profiles.json',dict(baseline=profile(joined,'cluster'),advanced=profile(rows,'cluster'),names=names))
    print(json.dumps(dict(validation=d,output_profiles=profile(rows,'cluster')),ensure_ascii=False),flush=True)


if __name__=='__main__':
    with threadpool_limits(limits=2):
        d=probes()
        make_plot()
        write_reports(d)
