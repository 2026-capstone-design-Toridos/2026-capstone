"""
preprocess_coveo_fast.py
-------------------------
Pandas-vectorized version of preprocess_coveo.py.
Much faster than the csv.DictReader version for large files.

Usage:
  python preprocess_coveo_fast.py \\
      --input  ../SIGIR-ecom-data-challenge/train/browsing_train.csv \\
      --outdir output/coveo \\
      --nrows  0          # 0 = all rows, otherwise limit
      --min_events 3 \\
      --max_len 8 \\
      --undersample
"""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict
from typing import Dict, List

import numpy as np
import pandas as pd
import torch

# ── vocab ──────────────────────────────────────────────────────────────────
SPECIAL_TOKENS: Dict[str, int] = {"[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[MASK]": 3}

ACTION_MAP: Dict[str, str] = {
    "detail":   "page_view",
    "add":      "add_to_cart",
    "remove":   "cart_remove",
    "purchase": "conversion_event",
}
PAGEVIEW_TOKEN = "page_browse"

GHOSTTRACKER_TOKENS = ["page_view", "page_browse", "add_to_cart", "cart_remove", "conversion_event"]

VOCAB: Dict[str, int] = dict(SPECIAL_TOKENS)
for _t in GHOSTTRACKER_TOKENS:
    if _t not in VOCAB:
        VOCAB[_t] = len(VOCAB)

LABEL_MAP: Dict[str, int] = {"conversion": 0, "cart_abandon": 1, "browse_only": 2}


# ── helpers ────────────────────────────────────────────────────────────────

# Coveo 이벤트 한 행을 GhostTracker 토큰 문자열로 변환한다
def map_token(event_type: str, product_action) -> str:
    if pd.notna(product_action) and product_action in ACTION_MAP:
        return ACTION_MAP[product_action]
    return PAGEVIEW_TOKEN


# 리스트를 왼쪽 패딩 / 오른쪽 자르기로 max_len 길이에 맞춘다
def pad_left(lst: List[int], max_len: int, pad_val: int = 0) -> List[int]:
    if len(lst) >= max_len:
        return lst[-max_len:]
    return [pad_val] * (max_len - len(lst)) + lst


# ── main ───────────────────────────────────────────────────────────────────

# CLI 인자를 파싱해 Namespace로 반환한다
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--input",       default="../SIGIR-ecom-data-challenge/train/browsing_train.csv")
    p.add_argument("--outdir",      default="output/coveo")
    p.add_argument("--nrows",       type=int, default=0, help="0 = all rows")
    p.add_argument("--min_events",  type=int, default=3)
    p.add_argument("--max_len",     type=int, default=8)
    p.add_argument("--undersample", action="store_true")
    p.add_argument("--seed",        type=int, default=42)
    return p.parse_args()


# pandas 벡터화 방식으로 로드 → 정렬 → 그룹핑 → 라벨 → 패딩 → .pt·vocab 저장
def main() -> None:
    args = parse_args()
    np.random.seed(args.seed)
    os.makedirs(args.outdir, exist_ok=True)
    MAX_LEN = args.max_len

    print("=" * 60)
    print("  Coveo SIGIR 2021  →  GhostTracker  [pandas fast path]")
    print("=" * 60)

    # ── 1. Load ──────────────────────────────────────────────────────────
    t0 = time.time()
    nrows_arg = args.nrows if args.nrows > 0 else None
    print(f"[1/5] Loading CSV (nrows={nrows_arg or 'all'}) …")
    df = pd.read_csv(
        args.input,
        nrows=nrows_arg,
        usecols=["session_id_hash", "event_type", "product_action",
                 "server_timestamp_epoch_ms"],
        dtype={
            "session_id_hash": "str",
            "event_type":      "str",
            "server_timestamp_epoch_ms": "int64",
        },
    )
    # product_action can be NaN → fill with empty string
    df["product_action"] = df["product_action"].fillna("")
    print(f"  {len(df):,} rows loaded in {time.time()-t0:.1f}s")
    print(f"  unique sessions: {df['session_id_hash'].nunique():,}")

    # ── 2. Sort & map tokens ──────────────────────────────────────────────
    print("[2/5] Sorting + mapping event tokens …")
    t1 = time.time()
    df.sort_values(["session_id_hash", "server_timestamp_epoch_ms"], inplace=True)
    df["token"] = df.apply(
        lambda r: map_token(r["event_type"], r["product_action"]), axis=1
    )
    df["token_id"] = df["token"].map(lambda t: VOCAB.get(t, VOCAB["[UNK]"]))
    print(f"  done in {time.time()-t1:.1f}s")

    # ── 3. Group by session ───────────────────────────────────────────────
    print("[3/5] Grouping into sessions …")
    t2 = time.time()

    # compute time gaps within each session
    df["ts_shifted"] = df.groupby("session_id_hash")["server_timestamp_epoch_ms"].shift(1)
    df["time_gap"] = ((df["server_timestamp_epoch_ms"] - df["ts_shifted"]) / 1000).fillna(0).clip(lower=0)

    grp = df.groupby("session_id_hash", sort=False)

    sess_token_ids   = grp["token_id"].apply(list)
    sess_time_gaps   = grp["time_gap"].apply(list)
    sess_actions     = grp["product_action"].apply(list)
    sess_lengths     = grp.size()

    print(f"  grouped {sess_lengths.shape[0]:,} sessions in {time.time()-t2:.1f}s")

    # ── 4. Filter & label ─────────────────────────────────────────────────
    print("[4/5] Filtering (min_events={}) + deriving labels …".format(args.min_events))
    t3 = time.time()

    # filter short sessions
    valid_idx = sess_lengths[sess_lengths >= args.min_events].index
    sess_token_ids = sess_token_ids[valid_idx]
    sess_time_gaps = sess_time_gaps[valid_idx]
    sess_actions   = sess_actions[valid_idx]

    print(f"  {len(valid_idx):,} sessions with ≥{args.min_events} events")

    # derive labels (vectorized with sets)
    def label_from_actions(actions):
        s = set(a for a in actions if a)
        if "purchase" in s:
            return "conversion"
        if "add" in s:
            return "cart_abandon"
        return "browse_only"

    labels = sess_actions.map(label_from_actions)

    # distribution
    dist = labels.value_counts()
    total_sess = len(labels)
    print(f"\n── Class distribution (before undersampling) ──────────")
    for lbl, cnt in dist.items():
        print(f"  {lbl:15s}  {cnt:8,}  ({100*cnt/total_sess:.1f}%)")

    # class weights
    n_classes = len(LABEL_MAP)
    weights_dict = {}
    for lbl, cnt in dist.items():
        if lbl in LABEL_MAP:
            weights_dict[LABEL_MAP[lbl]] = total_sess / (len(dist) * cnt)
    min_w = min(weights_dict.values())
    weights_list = [round(weights_dict.get(i, 0.0) / min_w, 3) for i in range(n_classes)]
    print(f"\n── Suggested class weights ────────────────────────────")
    for lbl, lid in sorted(LABEL_MAP.items(), key=lambda x: x[1]):
        print(f"  label {lid} ({lbl:15s})  weight = {weights_list[lid]:.3f}")
    print(f"  torch.tensor({weights_list})")

    # optional undersampling of browse_only
    if args.undersample:
        print("\n  Undersampling browse_only …")
        minority_count = dist.drop("browse_only", errors="ignore").sum()
        target = min(dist.get("browse_only", 0), 3 * minority_count)
        bo_idx = labels[labels == "browse_only"].index
        other_idx = labels[labels != "browse_only"].index
        rng = np.random.default_rng(args.seed)
        keep_bo = rng.choice(bo_idx, size=target, replace=False)
        keep_idx = np.concatenate([other_idx.values, keep_bo])
        sess_token_ids = sess_token_ids.loc[keep_idx]
        sess_time_gaps = sess_time_gaps.loc[keep_idx]
        labels         = labels.loc[keep_idx]
        print(f"  after undersample: {len(keep_idx):,} sessions")

    print(f"\n  label derivation done in {time.time()-t3:.1f}s")

    # ── 5. Pad / truncate + save ──────────────────────────────────────────
    print("[5/5] Padding to max_len={} and saving …".format(MAX_LEN))
    t4 = time.time()

    all_ids   = []
    all_gaps  = []
    all_masks = []
    all_lbls  = []
    all_sids  = []

    for sid in sess_token_ids.index:
        ids  = pad_left(sess_token_ids[sid], MAX_LEN, 0)
        gaps = pad_left([int(g) for g in sess_time_gaps[sid]], MAX_LEN, 0)
        mask = [0 if i == 0 else 1 for i in ids]
        lbl  = LABEL_MAP[labels[sid]]

        all_ids.append(ids)
        all_gaps.append(gaps)
        all_masks.append(mask)
        all_lbls.append(lbl)
        all_sids.append(sid)

    token_tensor = torch.tensor(all_ids,   dtype=torch.long)
    gap_tensor   = torch.tensor(all_gaps,  dtype=torch.float32)
    mask_tensor  = torch.tensor(all_masks, dtype=torch.long)
    label_tensor = torch.tensor(all_lbls,  dtype=torch.long)

    pt_path = os.path.join(args.outdir, "coveo_dataset.pt")
    torch.save({
        "token_ids":   token_tensor,
        "time_gaps":   gap_tensor,
        "attn_mask":   mask_tensor,
        "labels":      label_tensor,
        "session_ids": all_sids,
        "vocab":       VOCAB,
        "label_map":   LABEL_MAP,
        "max_len":     MAX_LEN,
    }, pt_path)

    vocab_path = os.path.join(args.outdir, "coveo_vocab.json")
    with open(vocab_path, "w") as fh:
        json.dump({"vocab": VOCAB, "label_map": LABEL_MAP,
                   "class_weights": weights_list}, fh, indent=2)

    print(f"  saved {len(all_sids):,} sessions → {pt_path}")
    print(f"  tensor shapes: token_ids={tuple(token_tensor.shape)}, labels={tuple(label_tensor.shape)}")
    print(f"  done in {time.time()-t4:.1f}s")
    print(f"\n✓ Total time: {time.time()-t0:.1f}s")
    print(f"  Next: python train_sasrec.py --data {pt_path}")


if __name__ == "__main__":
    main()
