# quick_start.py

from pymongo import MongoClient
from dotenv import load_dotenv
import os

# ===============================
# 1. MongoDB 연결
# ===============================
load_dotenv(dotenv_path="../backend/.env")

uri = os.getenv("MONGODB_URI")
print("Mongo URI:", uri)

client = MongoClient(uri)
events = list(client.ghosttracker.events.find())

print("총 이벤트 수:", len(events))


# ===============================
# 2. 시간 기반 세션 재구성
# ===============================
TIME_GAP = 2 * 60 * 1000  # 2분

sessions = []
current = []
prev = None

events_sorted = sorted(events, key=lambda x: x['timestamp'])

for e in events_sorted:
    t = e['timestamp']

    if prev and t - prev > TIME_GAP:
        sessions.append(current)
        current = []

    current.append(e)
    prev = t

if current:
    sessions.append(current)

print("재구성 세션 수:", len(sessions))


# ===============================
# 3. Sequence 생성
# ===============================
sequences = []

for evs in sessions:
    seq = []

    for e in evs:
        etype = e.get('event_type')

        if etype == "scroll_depth":
            depth = e.get("data", {}).get("depth_pct", 0)
            seq.append(f"scroll_{depth}")
        else:
            seq.append(etype)

    sequences.append(seq)

print("sequence 개수:", len(sequences))
print("샘플 sequence:", sequences[:3])


# ===============================
# 4. Embedding (Word2Vec)
# ===============================
from gensim.models import Word2Vec
import numpy as np

model = Word2Vec(
    sequences,
    vector_size=64,
    window=5,
    min_count=1
)

def embed(seq):
    vecs = [model.wv[w] for w in seq if w in model.wv]
    if not vecs:
        return np.zeros(64)
    return np.mean(vecs, axis=0)

X = np.array([embed(s) for s in sequences])

print("embedding shape:", X.shape)


# ===============================
# 5. Clustering (HDBSCAN)
# ===============================
import hdbscan

clusterer = hdbscan.HDBSCAN(
    min_cluster_size=5   # ⭐ 중요 (기존 20 → 실패 원인)
)

labels = clusterer.fit_predict(X)

print("클러스터 결과:", set(labels))


# ===============================
# 6. 클러스터 해석
# ===============================
from collections import Counter

cluster_map = {}

for label, seq in zip(labels, sequences):
    if label == -1:
        continue
    cluster_map.setdefault(label, []).extend(seq)

for k, v in cluster_map.items():
    print(f"\n======================")
    print(f"Cluster {k}")
    print("======================")
    print(Counter(v).most_common(10))
    
# ===============================
# 7. Cluster 이름 붙이기
# ===============================
# cluster 이름 자동 부여

def name_cluster(event_counts):
    events = dict(event_counts)

    if events.get('scroll_speed', 0) > 1000:
        return "Scanner (훑어보고 이탈)"

    if events.get('tab_exit', 0) > 50 and events.get('inactivity', 0) > 50:
        return "Distracted (주의 분산형)"

    if events.get('input_change', 0) > 30 or events.get('click', 0) > 50:
        return "Explorer (탐색형)"

    return "Other"


cluster_names = {}

for k, v in cluster_map.items():
    name = name_cluster(Counter(v))
    cluster_names[k] = name

    print(f"\nCluster {k} → {name}")
    

from sklearn.decomposition import PCA
import matplotlib.pyplot as plt

# PCA로 2차원 축소
pca = PCA(n_components=2)
X_2d = pca.fit_transform(X)

plt.figure()

for label in set(labels):
    idx = labels == label
    plt.scatter(X_2d[idx, 0], X_2d[idx, 1])

plt.title("User Behavior Clusters (PCA)")
plt.xlabel("PC1")
plt.ylabel("PC2")

plt.show()