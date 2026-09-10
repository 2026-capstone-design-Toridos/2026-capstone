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

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)
from build_session_sequences import (  # noqa: E402
    build_semantic_sequence_for_session,
    event_sort_key,
)

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
    """학습 파이프라인과 같은 규칙으로 raw event를 semantic token으로 바꾼다."""
    if not events:
        return []

    # 기존 API 사용자가 이미 변환한 대문자 semantic event를 보내는 경우는
    # 계속 지원한다. SDK의 소문자 raw event는 공통 전처리기로 보낸다.
    event_types = [str(ev.get("event_type", "")) for ev in events]
    if event_types and all(et in EVENT_TO_SEMANTIC for et in event_types):
        return [
            f"{PAGE_MAP.get(str(ev.get('page', '')).lower(), 'UNKNOWN')}|"
            f"{EVENT_TO_SEMANTIC[str(ev.get('event_type'))]}|NONE"
            for ev in events
        ]

    return build_semantic_sequence_for_session(sorted(events, key=event_sort_key))["sequence"]


# ══════════════════════════════════════════════════════════════════════════════
# 학습 모델 정의 재사용
#
# 과거에는 이 파일이 TransformerMLM 이라는 별도 클래스를 자체 정의했다.
# 그러나 실제 학습은 train_transformer_encoder.SessionTransformerEncoder 로
# 이루어지고 두 클래스는 state_dict 키가 다르다.
#     학습:  token_embedding / position_embedding / output_head  (LayerNorm 없음)
#     서버:  token_emb       / pos_emb            / head + norm
# 겹치는 키가 encoder.layers.* 뿐이라 load_state_dict(strict=False) 가
# 임베딩을 랜덤 초기값으로 남긴 채 조용히 통과했다.
#
# 모델 정의는 한 곳에만 존재해야 한다. 학습 코드에서 직접 import 한다.
# ══════════════════════════════════════════════════════════════════════════════

SessionTransformerEncoder = None

if HAS_TORCH:
    try:
        _THIS_DIR = os.path.dirname(os.path.abspath(__file__))
        if _THIS_DIR not in sys.path:
            sys.path.insert(0, _THIS_DIR)
        from train_transformer_encoder import (  # noqa: E402
            SessionTransformerEncoder as _SessionTransformerEncoder,
        )
        SessionTransformerEncoder = _SessionTransformerEncoder
    except Exception as _e:  # pragma: no cover
        print(f"[ClusterServer] 학습 모델 정의 import 실패: {_e}")


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

        # 중심점에 가장 가깝다는 이유만으로 모든 세션을 강제 배정하지 않는다.
        # 메타파일 또는 환경변수로 운영 데이터에 맞게 조정할 수 있다.
        configured_gate = meta.get("inference_quality_gate", {})
        self.quality_gate = {
            "min_tokens": int(os.getenv(
                "CLUSTER_MIN_TOKENS", configured_gate.get("min_tokens", 3)
            )),
            "min_similarity": float(os.getenv(
                "CLUSTER_MIN_SIMILARITY", configured_gate.get("min_similarity", 0.55)
            )),
            "min_margin": float(os.getenv(
                "CLUSTER_MIN_MARGIN", configured_gate.get("min_margin", 0.05)
            )),
            "max_unknown_ratio": float(os.getenv(
                "CLUSTER_MAX_UNKNOWN_RATIO", configured_gate.get("max_unknown_ratio", 0.20)
            )),
        }

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

        if SessionTransformerEncoder is None:
            raise RuntimeError(
                "train_transformer_encoder.SessionTransformerEncoder 를 import 하지 못했습니다."
            )

        ckpt = torch.load(encoder_path, map_location=self.device, weights_only=False)

        state = ckpt.get("model_state_dict", ckpt.get("encoder_state"))
        if state is None:
            raise RuntimeError(
                "체크포인트에 model_state_dict 가 없습니다. "
                "train_transformer_encoder.py 로 학습한 파일인지 확인하세요."
            )

        # 하이퍼파라미터는 체크포인트의 model_config를 신뢰한다.
        # meta 값으로 추측하면 학습과 다른 구조를 만들 수 있다.
        cfg = ckpt.get("model_config")
        if not cfg:
            raise RuntimeError(
                "체크포인트에 model_config 가 없습니다. 모델 구조를 복원할 수 없습니다."
            )

        self.pooling = ckpt.get("pooling", meta.get("pooling", "mean"))

        self.bert = SessionTransformerEncoder(
            vocab_size = cfg["vocab_size"],
            max_len    = cfg["max_len"],
            pad_id     = cfg["pad_id"],
            embed_dim  = cfg["embed_dim"],
            num_heads  = cfg["num_heads"],
            num_layers = cfg["num_layers"],
            ff_dim     = cfg["ff_dim"],
            dropout    = 0.0,
        ).to(self.device)

        # strict=True — 키가 하나라도 어긋나면 즉시 실패한다.
        # strict=False 로 두면 임베딩이 랜덤인 채 서버가 정상 기동해
        # 근거 없는 분류 결과를 내놓는다. 조용한 오작동이 가장 위험하다.
        self.bert.load_state_dict(state, strict=True)

        self.bert.eval()
        self.max_len = cfg["max_len"]

        if cfg["vocab_size"] != len(self.vocab):
            raise RuntimeError(
                f"vocab 불일치: 체크포인트 {cfg['vocab_size']} vs "
                f"cluster_meta.json {len(self.vocab)}. "
                "artifacts를 같은 학습 실행에서 함께 export 했는지 확인하세요."
            )

        print(
            f"[ClusterServer] SessionTransformerEncoder 로드 완료 "
            f"(d={cfg['embed_dim']}, layers={cfg['num_layers']}, "
            f"heads={cfg['num_heads']}, max_len={cfg['max_len']}, "
            f"vocab={cfg['vocab_size']}, pooling={self.pooling})"
        )

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
        """
        prepare_transformer_input.encode_sequence 와 동일한 규칙으로 인코딩한다.
          - [CLS] 를 맨 앞에 붙인다
          - 길이 초과 시 뒤쪽(최근 행동)을 보존한다 (truncate_side="left")
          - 오른쪽 패딩, attention_mask 는 실제 토큰만 1
        인코딩 규칙이 학습과 다르면 임베딩이 다른 공간에 놓여
        centroid 비교가 무의미해진다.
        """
        import torch
        PAD = self.vocab.get("[PAD]", 0)
        CLS = self.vocab.get("[CLS]", 3)

        ids = [CLS] + token_ids[-(self.max_len - 1):]

        attn = [1] * len(ids)
        pad_len = self.max_len - len(ids)
        if pad_len > 0:
            ids = ids + [PAD] * pad_len
            attn = attn + [0] * pad_len

        id_t = torch.tensor([ids], dtype=torch.long, device=self.device)
        mask = torch.tensor([attn], dtype=torch.long, device=self.device)

        with torch.no_grad():
            # 학습 시 session_embeddings.npy 를 만든 것과 같은 pooling 을 써야
            # centroid 와 같은 공간에 놓인다 (기본 mean).
            emb = self.bert.encode(id_t, mask, pooling=getattr(self, "pooling", "mean"))
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

        sorted_distances = np.sort(dists)
        margin = (
            float(sorted_distances[1] - sorted_distances[0])
            if len(sorted_distances) > 1 else 1.0
        )
        known_count = sum(1 for token in tokens if token in self.vocab)
        unknown_ratio = 1.0 - (known_count / len(tokens))

        # confidence: 1 - normalized_distance (0~1)
        confidence = max(0.0, round(1.0 - best_d, 4))

        distances_map = {
            str(i): round(float(d), 4) for i, d in enumerate(dists)
        }
        semantic_action_counts: Dict[str, int] = {}
        page_counts: Dict[str, int] = {}
        for token in tokens:
            parts = token.split("|")
            if len(parts) != 3:
                continue
            page, action, _ = parts
            semantic_action_counts[action] = semantic_action_counts.get(action, 0) + 1
            page_counts[page] = page_counts.get(page, 0) + 1

        rejection_reasons = []
        if len(tokens) < self.quality_gate["min_tokens"]:
            rejection_reasons.append("too_few_semantic_tokens")
        if confidence < self.quality_gate["min_similarity"]:
            rejection_reasons.append("low_similarity")
        if margin < self.quality_gate["min_margin"]:
            rejection_reasons.append("ambiguous_between_clusters")
        if unknown_ratio > self.quality_gate["max_unknown_ratio"]:
            rejection_reasons.append("too_many_unknown_tokens")

        accepted = not rejection_reasons

        return {
            "cluster_id": best_id if accepted else -1,
            "candidate_cluster_id": best_id,
            "persona": (
                self.cluster_labels.get(str(best_id), f"Cluster {best_id}")
                if accepted else None
            ),
            "confidence": confidence,
            "margin": round(margin, 4),
            "unknown_ratio": round(unknown_ratio, 4),
            "accepted": accepted,
            "rejection_reasons": rejection_reasons,
            "semantic_action_counts": semantic_action_counts,
            "page_counts": page_counts,
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
# 서버 상태와 모드(bert/tfidf), 클러스터 수를 반환한다
def health():
    if predictor is None:
        return jsonify({"status": "initializing"}), 503
    return jsonify({
        "status":     "ok",
        "mode":       predictor.mode,
        "n_clusters": predictor.n_clusters,
        "model":      "ghosttracker_cluster",
        "quality_gate": predictor.quality_gate,
    })


@app.route("/classify", methods=["POST"])
# tokens 또는 events를 받아 클러스터 분류 결과를 반환한다
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


# CLI 인자(--model_dir, --port, --host, --device)를 파싱한다
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
