"""
cluster_server.py
-----------------
GhostTracker 실시간 세션 → 페르소나(클러스터) 분류 Flask 서버 (port 5002)

Colab에서 export_artifacts 셀을 실행한 후 생성된 파일들을 사용한다:
  ml/output/unsupervised_semantic/bert_encoder.pt       (TorchScript 모델)
  ml/output/unsupervised_semantic/cluster_centroids.npy (클러스터 중심 벡터)
  ml/output/unsupervised_semantic/cluster_meta.json     (vocab + 페르소나 레이블)

──────────────────────────────────────────────────────────────────
API
──────────────────────────────────────────────────────────────────

POST /classify
  Body:
    {
      "session_id": "abc-123",      // optional
      "tokens": ["PRODUCT|ENTER_PRODUCT|NONE", "PRODUCT|SCROLL_PRODUCT|NONE", ...]
    }
    또는
    {
      "session_id": "abc-123",
      "events": [                   // 원시 이벤트 (token 변환 포함)
        {"event_type": "ENTER_PRODUCT", "page": "PRODUCT"},
        ...
      ]
    }

  Response:
    {
      "session_id": "abc-123",
      "cluster_id": 3,
      "persona":    "가격 비교형",
      "confidence": 0.87,           // 1 - normalized_distance
      "distances":  { "0": 0.12, "1": 0.43, "2": 0.91, ... },
      "seq_len":    14,
      "mode":       "bert"          // "bert" | "tfidf" (fallback)
    }

POST /classify/batch
  Body: { "sessions": [{ "session_id"?, "tokens"? | "events"? }, ...] }
  Response: { "results": [...] }

GET /health
  Response: { "status": "ok", "mode": "bert"|"tfidf", "n_clusters": 12 }

──────────────────────────────────────────────────────────────────
실행
──────────────────────────────────────────────────────────────────
  cd ml/
  python cluster_server.py
  python cluster_server.py --port 5002 --model_dir output/unsupervised_semantic
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import math
from typing import Dict, List, Optional, Tuple

import numpy as np
from flask import Flask, jsonify, request

# ── PyTorch 로드 시도 ─────────────────────────────────────────────────────────
try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

# ── 세만틱 토큰 빌더 (3-part PAGE|SEMANTIC|CONTEXTUAL 포맷) ─────────────────
#    원시 이벤트를 넘겼을 때 사용하는 경량 매핑 (semantic_event_mapper 없이)
EVENT_TO_SEMANTIC: Dict[str, str] = {
    "ENTER_HOME":             "ENTER_HOME",
    "ENTER_PRODUCT":          "ENTER_PRODUCT",
    "ENTER_CART":             "ENTER_CART",
    "ENTER_CHECKOUT":         "ENTER_CHECKOUT",
    "SCROLL_PRODUCT":         "SCROLL_PRODUCT",
    "SCROLL_PRODUCT_DETAIL":  "SCROLL_PRODUCT_DETAIL",
    "SCROLL_REVIEW":          "SCROLL_REVIEW",
    "SCROLL_HOME":            "SCROLL_HOME",
    "ZOOM_IMAGE":             "ZOOM_IMAGE",
    "ADD_CART":               "ADD_CART",
    "REMOVE_CART":            "REMOVE_CART",
    "CLICK_BUY":              "CLICK_BUY",
    "VIEW_REVIEW":            "VIEW_REVIEW",
    "CHECK_PRICE":            "CHECK_PRICE",
    "CHECK_SHIPPING":         "CHECK_SHIPPING",
    "CHECK_SIZE":             "CHECK_SIZE",
    "SEARCH_USE":             "SEARCH_USE",
    "HOVER_ELEMENT":          "HOVER_ELEMENT",
    "CLICK_ELEMENT":          "CLICK_ELEMENT",
    "START_SESSION":          "START_SESSION",
    "TAB_OUT":                "TAB_OUT",
    "TAB_RETURN":             "TAB_RETURN",
    "INACTIVE":               "INACTIVE",
    "EXIT_SESSION":           "EXIT_SESSION",
    "EXIT_BOUNCE":            "EXIT_BOUNCE",
    "RAGE_CLICK":             "RAGE_CLICK",
}

PAGE_MAP: Dict[str, str] = {
    "home":      "HOME",
    "product":   "PRODUCT",
    "cart":      "CART",
    "checkout":  "CHECKOUT",
    "search":    "SEARCH",
}


def events_to_tokens(events: List[dict]) -> List[str]:
    """원시 이벤트 리스트 → PAGE|SEMANTIC|CONTEXTUAL 토큰 리스트"""
    tokens = []
    for ev in events:
        et   = ev.get("event_type", "")
        page = PAGE_MAP.get(str(ev.get("page", "")).lower(), "UNKNOWN")
        sem  = EVENT_TO_SEMANTIC.get(et, "CLICK_ELEMENT")
        tokens.append(f"{page}|{sem}|NONE")
    return tokens


# ══════════════════════════════════════════════════════════════════════════════
# TransformerMLM – Colab colab_pretrain_cluster.ipynb의 실제 모델 구조
# (bert_encoder.pt state_dict 키 이름과 정확히 일치해야 함)
# ══════════════════════════════════════════════════════════════════════════════

if HAS_TORCH:
    class TransformerMLM(nn.Module):
        """
        Colab 학습 모델과 동일한 구조.
        state_dict 키: token_emb, pos_emb, norm, encoder, head
        forward() → [CLS] 위치(index 0)의 hidden state 반환
        """
        def __init__(
            self,
            vocab_size: int,
            embed_dim: int    = 64,
            nhead: int        = 4,
            num_layers: int   = 2,
            max_len: int      = 60,
            dim_feedforward: int = 128,
            dropout: float    = 0.1,
        ):
            super().__init__()
            self.embed_dim = embed_dim
            self.max_len   = max_len

            self.token_emb = nn.Embedding(vocab_size, embed_dim)
            self.pos_emb   = nn.Embedding(max_len + 5, embed_dim)
            self.norm      = nn.LayerNorm(embed_dim)

            enc_layer = nn.TransformerEncoderLayer(
                d_model=embed_dim, nhead=nhead,
                dim_feedforward=dim_feedforward,
                dropout=dropout, batch_first=True,
            )
            self.encoder = nn.TransformerEncoder(enc_layer, num_layers=num_layers)
            self.head     = nn.Linear(embed_dim, vocab_size)   # MLM head (inference에서는 무시)

        def forward(
            self,
            input_ids: "torch.Tensor",       # (B, L)
            attention_mask: "torch.Tensor",  # (B, L), 1=실제 토큰 0=패드
        ) -> "torch.Tensor":                 # (B, embed_dim) – index 0 ([CLS]) hidden state
            B, L = input_ids.shape
            positions = torch.arange(L, device=input_ids.device).unsqueeze(0)

            x = self.token_emb(input_ids) + self.pos_emb(positions)
            x = self.norm(x)

            src_key_padding_mask = (attention_mask == 0)  # True = 무시
            x = self.encoder(x, src_key_padding_mask=src_key_padding_mask)

            return x[:, 0, :]   # (B, embed_dim) – [CLS] 임베딩


# ══════════════════════════════════════════════════════════════════════════════
# Predictor
# ══════════════════════════════════════════════════════════════════════════════

class ClusterPredictor:
    """
    BERT 모델 + 클러스터 중심점을 로드해 새 세션을 분류한다.
    모델 파일이 없으면 TF-IDF 코사인 유사도 fallback을 사용한다.
    """

    MODE_BERT  = "bert"
    MODE_TFIDF = "tfidf"

    def __init__(self, model_dir: str, device: str = "cpu"):
        self.model_dir = model_dir
        self.device    = device
        self.mode      = self.MODE_TFIDF

        meta_path      = os.path.join(model_dir, "cluster_meta.json")
        centroids_path = os.path.join(model_dir, "cluster_centroids.npy")
        encoder_path   = os.path.join(model_dir, "bert_encoder.pt")

        # ── 공통: cluster_meta.json ─────────────────────────────────────────
        if not os.path.exists(meta_path):
            raise FileNotFoundError(
                f"cluster_meta.json 없음: {meta_path}\n"
                "Colab에서 export_artifacts 셀을 실행하세요."
            )
        with open(meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)

        self.vocab: Dict[str, int] = meta["vocab"]   # token → id
        self.id2tok = {v: k for k, v in self.vocab.items()}

        # ── cluster_labels: NLP 라벨이 있으면 우선 사용 ─────────────────────
        if meta.get("nlp_labels"):
            self.cluster_labels = {
                str(k): (v.get("name") if isinstance(v, dict) else str(v))
                for k, v in meta["nlp_labels"].items()
            }
        elif meta.get("cluster_labels"):
            self.cluster_labels: Dict[str, str] = {
                str(k): v for k, v in meta["cluster_labels"].items()
            }
        elif meta.get("cluster_profiles"):
            self.cluster_labels = self._labels_from_profiles(meta["cluster_profiles"])
        elif meta.get("cluster_ids"):
            self.cluster_labels = {str(i): f"Cluster {i}" for i in meta["cluster_ids"]}
        else:
            self.cluster_labels = {}

        self.n_clusters = len(self.cluster_labels) or meta.get("num_clusters", 0)
        print(f"[ClusterServer] vocab_size={len(self.vocab)}, n_clusters={self.n_clusters}")

        # ── TF-IDF 중심점 (항상 로드, fallback용) ─────────────────────────
        self.tfidf_centroids: Optional[np.ndarray] = None
        if "tfidf_centroids" in meta:
            self.tfidf_centroids = np.array(meta["tfidf_centroids"], dtype=np.float32)
            # shape: (n_clusters, vocab_size)

        # ── BERT 중심점 + 모델 ──────────────────────────────────────────────
        if HAS_TORCH and os.path.exists(centroids_path) and os.path.exists(encoder_path):
            try:
                self._load_bert(encoder_path, centroids_path, meta)
                self.mode = self.MODE_BERT
                print("[ClusterServer] BERT 모드로 시작합니다.")
            except Exception as e:
                print(f"[ClusterServer] BERT 로드 실패 ({e}) → TF-IDF 모드로 전환")
        else:
            missing = []
            if not HAS_TORCH:          missing.append("torch 미설치")
            if not os.path.exists(centroids_path): missing.append("cluster_centroids.npy 없음")
            if not os.path.exists(encoder_path):   missing.append("bert_encoder.pt 없음")
            print(f"[ClusterServer] TF-IDF 모드 ({', '.join(missing)})")

        if self.mode == self.MODE_TFIDF and self.tfidf_centroids is None:
            raise RuntimeError(
                "cluster_meta.json에 tfidf_centroids가 없고 BERT 파일도 없습니다.\n"
                "Colab export_artifacts 셀을 재실행하세요."
            )

    # ── cluster_profiles → cluster_labels 생성 헬퍼 ─────────────────────────
    @staticmethod
    def _labels_from_profiles(profiles: dict) -> Dict[str, str]:
        labels = {}
        for cid, prof in profiles.items():
            top = [a["action"] for a in prof.get("top_actions", [])[:2]]
            page_dist = prof.get("page_dist", {})
            main_page = max(page_dist, key=lambda k: page_dist[k]) if page_dist else "?"
            label = f"C{cid}:{'+'.join(top)}/{main_page}" if top else f"Cluster {cid}"
            labels[str(cid)] = label
        return labels

    # ── TransformerMLM 로드 ──────────────────────────────────────────────────
    def _load_bert(self, encoder_path: str, centroids_path: str, meta: dict):
        import torch

        ckpt = torch.load(encoder_path, map_location=self.device, weights_only=False)

        # 체크포인트에서 하이퍼파라미터 추출
        embed_dim  = ckpt.get("embed_dim",   meta.get("embedding_dim", 64))
        max_len    = ckpt.get("max_len",     meta.get("max_len", 60))
        vocab_size = ckpt.get("vocab_size",  len(self.vocab))

        # state_dict 키로 num_layers, dim_feedforward 역산
        state = ckpt.get("model_state_dict", ckpt.get("encoder_state", ckpt))
        layer_indices = sorted(set(
            int(k.split(".")[2])
            for k in state if k.startswith("encoder.layers.")
        ))
        num_layers = len(layer_indices) or 2

        ff_key = f"encoder.layers.0.linear1.weight"
        dim_feedforward = state[ff_key].shape[0] if ff_key in state else embed_dim * 2

        pos_key = "pos_emb.weight"
        if pos_key in state:
            # The model allocates max_len + 5 positions. Infer this value from
            # the checkpoint so older exported metadata cannot cause a mismatch.
            max_len = int(state[pos_key].shape[0]) - 5

        # nhead: embed_dim의 약수 중 가장 큰 값 (최대 8)
        nhead = next(
            (n for n in [8, 4, 2, 1] if embed_dim % n == 0),
            4,
        )

        self.bert = TransformerMLM(
            vocab_size      = vocab_size,
            embed_dim       = embed_dim,
            nhead           = nhead,
            num_layers      = num_layers,
            max_len         = max_len,
            dim_feedforward = dim_feedforward,
            dropout         = 0.0,
        ).to(self.device)

        missing, unexpected = self.bert.load_state_dict(state, strict=False)
        if missing:
            print(f"[ClusterServer] 누락 키 (무시 가능): {missing[:3]}")
        if unexpected:
            print(f"[ClusterServer] 예상치 못한 키 (무시): {unexpected[:3]}")

        self.bert.eval()
        self.max_len = max_len
        print(f"[ClusterServer] TransformerMLM 로드 완료 "
              f"(d={embed_dim}, layers={num_layers}, nhead={nhead}, max_len={max_len})")

        # 중심점: (n_clusters, embed_dim) float32
        self.bert_centroids = torch.tensor(
            np.load(centroids_path), dtype=torch.float32, device=self.device
        )

    # ── 토큰 → id 변환 ──────────────────────────────────────────────────────
    def _tokens_to_ids(self, tokens: List[str]) -> List[int]:
        UNK = self.vocab.get("[UNK]", 1)
        return [self.vocab.get(tok, UNK) for tok in tokens]

    # ── BERT 임베딩 ──────────────────────────────────────────────────────────
    def _embed_bert(self, token_ids: List[int]) -> np.ndarray:
        import torch
        PAD = self.vocab.get("[PAD]", 0)
        CLS = self.vocab.get("[CLS]", 2)

        # [CLS] 앞에 추가 후 max_len-1 개 토큰 잘라내기
        ids = [CLS] + token_ids[-(self.max_len - 1):]

        # 오른쪽 패딩 (Colab 학습 방식과 동일)
        pad_len = self.max_len - len(ids)
        ids = ids + [PAD] * pad_len

        id_t = torch.tensor([ids], dtype=torch.long, device=self.device)
        mask = (id_t != PAD).long()

        with torch.no_grad():
            emb = self.bert(id_t, mask)   # (1, embed_dim)
        return emb[0].cpu().numpy()

    # ── TF-IDF 벡터 ─────────────────────────────────────────────────────────
    def _embed_tfidf(self, tokens: List[str]) -> np.ndarray:
        vec = np.zeros(len(self.vocab), dtype=np.float32)
        for tok in tokens:
            idx = self.vocab.get(tok)
            if idx is not None:
                vec[idx] += 1.0
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    # ── 코사인 유사도 ────────────────────────────────────────────────────────
    @staticmethod
    def _cosine_distances(vec: np.ndarray, centroids: np.ndarray) -> np.ndarray:
        """Returns distances (1 - cosine_similarity) for each centroid."""
        nv  = vec / (np.linalg.norm(vec) + 1e-9)
        nc  = centroids / (np.linalg.norm(centroids, axis=1, keepdims=True) + 1e-9)
        sims = nc @ nv              # (n_clusters,)
        return 1.0 - sims           # distance

    # ── 메인 분류 ────────────────────────────────────────────────────────────
    def classify(self, tokens: List[str]) -> dict:
        if not tokens:
            return {"error": "tokens 리스트가 비어 있습니다."}

        if self.mode == self.MODE_BERT:
            ids  = self._tokens_to_ids(tokens)
            vec  = self._embed_bert(ids)
            bc   = self.bert_centroids.cpu().numpy()
            dists = self._cosine_distances(vec, bc)
        else:
            vec   = self._embed_tfidf(tokens)
            dists = self._cosine_distances(vec, self.tfidf_centroids)

        best_id = int(np.argmin(dists))
        best_d  = float(dists[best_id])

        # confidence: 1 - normalized_distance (0~1)
        confidence = max(0.0, round(1.0 - best_d, 4))

        distances_map = {
            str(i): round(float(d), 4) for i, d in enumerate(dists)
        }

        return {
            "cluster_id": best_id,
            "persona":    self.cluster_labels.get(str(best_id), f"Cluster {best_id}"),
            "confidence": confidence,
            "distances":  distances_map,
            "seq_len":    len(tokens),
            "mode":       self.mode,
        }


# ══════════════════════════════════════════════════════════════════════════════
# Flask 앱
# ══════════════════════════════════════════════════════════════════════════════

app       = Flask(__name__)
predictor: ClusterPredictor | None = None


@app.route("/health", methods=["GET"])
def health():
    if predictor is None:
        return jsonify({"status": "initializing"}), 503
    return jsonify({
        "status":     "ok",
        "mode":       predictor.mode,
        "n_clusters": predictor.n_clusters,
        "model":      "ghosttracker_cluster",
    })


@app.route("/classify", methods=["POST"])
def classify():
    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "JSON body 필요"}), 400

    # 토큰 직접 제공 or 이벤트 → 토큰 변환
    tokens = body.get("tokens")
    if tokens is None:
        raw_events = body.get("events", [])
        if not isinstance(raw_events, list):
            return jsonify({"error": "tokens 또는 events 배열이 필요합니다."}), 400
        tokens = events_to_tokens(raw_events)

    if not isinstance(tokens, list):
        return jsonify({"error": "tokens는 배열이어야 합니다."}), 400

    result = predictor.classify(tokens)
    if "error" in result:
        return jsonify(result), 400

    session_id = body.get("session_id")
    if session_id:
        result["session_id"] = session_id

    return jsonify(result)


@app.route("/classify/batch", methods=["POST"])
def classify_batch():
    """여러 세션 한 번에 분류"""
    body = request.get_json(silent=True)
    if not body or "sessions" not in body:
        return jsonify({"error": "sessions 배열 필요"}), 400

    results = []
    for sess in body["sessions"]:
        tokens = sess.get("tokens")
        if tokens is None:
            tokens = events_to_tokens(sess.get("events", []))
        r = predictor.classify(tokens)
        sid = sess.get("session_id")
        if sid:
            r["session_id"] = sid
        results.append(r)

    return jsonify({"results": results, "count": len(results)})


def parse_args():
    p = argparse.ArgumentParser(description="GhostTracker Cluster Inference Server")
    p.add_argument("--model_dir", default="output/unsupervised_semantic",
                   help="bert_encoder.pt, cluster_centroids.npy, cluster_meta.json 위치")
    p.add_argument("--port",      type=int, default=5002)
    p.add_argument("--host",      default="0.0.0.0")
    p.add_argument("--device",    default="cpu")
    return p.parse_args()


if __name__ == "__main__":
    args      = parse_args()
    predictor = ClusterPredictor(args.model_dir, device=args.device)
    print(f"[GhostTracker] 클러스터 분류 서버 → http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, debug=False)
