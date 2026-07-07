"""
colab_export_artifacts.py
=========================
Colab 노트북에서 실행하는 export 셀 코드.

Step 5(clustering) 셀 이후에 이 코드를 새 셀로 추가해 실행하면
cluster_server.py가 필요한 파일들이 Drive에 저장된다.

저장 경로: GhostTracker/output/unsupervised_semantic/
  - cluster_meta.json      (vocab + 레이블 + TF-IDF 중심점)
  - cluster_centroids.npy  (BERT 임베딩 중심점)
  - bert_encoder.pt        (인코더 가중치)

셀 태그: export_artifacts
"""

# ─────────────────────────────────────────────────────────────────────────────
# 이 블록을 Colab 셀에 붙여넣으세요
# ─────────────────────────────────────────────────────────────────────────────
COLAB_CELL_CODE = '''
# @title Step 8: Export Artifacts for cluster_server.py { display-mode: "form" }
import json, os
import numpy as np
import torch

OUT_DIR = f"{BASE}/output/unsupervised_semantic"
os.makedirs(OUT_DIR, exist_ok=True)

# ── 1. cluster_meta.json 생성 ────────────────────────────────────────────────
# cluster_labels: Colab Step 7(profile) 셀에서 정의한 CLUSTER_LABELS 사용
# 없으면 자동 생성
try:
    label_map = CLUSTER_LABELS          # Step 7 셀에서 정의돼 있어야 함
except NameError:
    # 자동 fallback
    unique_clusters = sorted(df_results["cluster"].unique())
    label_map = {int(c): f"Cluster {c}" for c in unique_clusters if c != -1}

# TF-IDF 중심점: 클러스터별 평균 토큰 빈도 벡터 계산
all_tokens = sorted(set(
    tok for seq in df_seq["token_sequence"].dropna()
    for tok in seq.strip().split()
    if tok
))
tok2id = {"[PAD]": 0, "[UNK]": 1, "[MASK]": 2}
for t in all_tokens:
    if t not in tok2id:
        tok2id[t] = len(tok2id)

vocab_size = len(tok2id)
n_cls = len(label_map)

# df_results: cluster_id per session, df_seq: token_sequence per session
merged = df_results.merge(df_seq[["session_id","token_sequence"]], on="session_id", how="left")

tfidf_centroids = []
for cid in sorted(label_map.keys()):
    subset = merged[merged["cluster"] == cid]["token_sequence"].dropna()
    centroid = np.zeros(vocab_size, dtype=np.float32)
    for seq in subset:
        for tok in seq.strip().split():
            idx = tok2id.get(tok, 1)
            centroid[idx] += 1.0
    norm = np.linalg.norm(centroid)
    if norm > 0:
        centroid /= norm
    tfidf_centroids.append(centroid.tolist())

meta = {
    "vocab": tok2id,
    "cluster_labels": {str(k): v for k, v in label_map.items()},
    "bert_config": {
        "d_model":    D_MODEL,      # Colab config 셀에서 정의
        "nhead":      N_HEAD,
        "num_layers": N_LAYERS,
        "max_len":    MAX_LEN,
    },
    "tfidf_centroids": tfidf_centroids,
}
meta_path = f"{OUT_DIR}/cluster_meta.json"
with open(meta_path, "w", encoding="utf-8") as f:
    json.dump(meta, f, ensure_ascii=False, indent=2)
print(f"✅ cluster_meta.json 저장 완료 (vocab={vocab_size}, clusters={n_cls})")

# ── 2. BERT 임베딩 중심점 저장 ───────────────────────────────────────────────
# all_embeddings, all_labels: Step 5(clustering) 셀에서 계산된 변수
bert_centroids = []
for cid in sorted(label_map.keys()):
    mask = np.array(all_labels) == cid
    cluster_embs = all_embeddings[mask]
    bert_centroids.append(cluster_embs.mean(axis=0))

centroids_arr = np.array(bert_centroids, dtype=np.float32)
np.save(f"{OUT_DIR}/cluster_centroids.npy", centroids_arr)
print(f"✅ cluster_centroids.npy 저장 완료 (shape={centroids_arr.shape})")

# ── 3. BERT 인코더 가중치 저장 ───────────────────────────────────────────────
# bert_model: Step 6(pretrain) 또는 Step 7(finetune) 셀에서 정의된 모델
encoder_state = {}
for k, v in bert_model.state_dict().items():
    if not k.startswith("mlm_head"):    # MLM head 제외, encoder만 저장
        encoder_state[k] = v

torch.save(
    {
        "encoder_state": encoder_state,
        "bert_config": meta["bert_config"],
    },
    f"{OUT_DIR}/bert_encoder.pt",
)
print(f"✅ bert_encoder.pt 저장 완료")

print()
print("=" * 60)
print("Export 완료! Google Drive에서 로컬로 다운로드:")
print(f"  {OUT_DIR}/cluster_meta.json")
print(f"  {OUT_DIR}/cluster_centroids.npy")
print(f"  {OUT_DIR}/bert_encoder.pt")
print()
print("로컬 저장 경로 (ml/output/unsupervised_semantic/ 에 복사):")
print("  → cluster_server.py가 자동으로 인식합니다.")
'''

# ─────────────────────────────────────────────────────────────────────────────
# Colab 노트북에 셀 자동 삽입하는 JS 코드 (Colab 환경에서 실행)
# ─────────────────────────────────────────────────────────────────────────────
COLAB_INSERT_JS = """
(async () => {
  const nb = colab.global.notebookModel;
  const keys = Object.keys(nb.cells);
  const lastKey = keys[keys.length - 1];

  const newCell = nb.createCellFromJson({
    cell_type: 'code',
    source: [],
    metadata: { id: 'export_artifacts' },
    outputs: []
  });

  nb.cells.insertAfter(newCell, nb.cells.get(lastKey));

  const code = `# @title Step 8: Export Artifacts for cluster_server.py
""" + COLAB_CELL_CODE.replace('`', '\\`').replace('${', '\\${') + """
`;
  newCell.setText(code);

  // 저장
  await new Promise(r => setTimeout(r, 500));
  nb.save();
  console.log('[GhostTracker] export_artifacts 셀 추가 완료');
})();
"""

if __name__ == "__main__":
    print("=" * 60)
    print("Colab export_artifacts 셀 코드")
    print("=" * 60)
    print()
    print("아래 코드를 Colab 노트북의 마지막 셀 다음에 새 셀로 추가하세요:")
    print()
    print(COLAB_CELL_CODE)
