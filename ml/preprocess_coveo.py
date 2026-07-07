"""
preprocess_coveo.py
-------------------
Coveo SIGIR 2021 browsing_train.csv → GhostTracker-format session dataset.

Pipeline
--------
1.  Load browsing_train.csv in chunks (memory-safe).
2.  Sort each session by timestamp → compute time_gap (seconds).
3.  Map Coveo event tokens → GhostTracker vocab:
      detail   → page_view
      add      → add_to_cart
      remove   → cart_remove
      purchase → conversion
      pageview (no product action) → page_browse
4.  Derive session-level label:
      conversion   – session contains a purchase action
      cart_abandon – session has add but no purchase
      bounce       – session has ≤2 events AND no product action
      browse_only  – everything else
5.  Filter sessions with < MIN_EVENTS events.
6.  Truncate / left-pad to MAX_LEN tokens (pad_id = 0).
7.  Write output/coveo_processed.csv  (human-readable)
        and output/coveo_dataset.pt   (PyTorch tensors, ready for training).
8.  Write output/coveo_vocab.json     (token → id mapping).
9.  Print class distribution + suggest class weights.

Usage
-----
  python preprocess_coveo.py \\
      --input  ../SIGIR-ecom-data-challenge/train/browsing_train.csv \\
      --outdir output/coveo \\
      --min_events 3 \\
      --max_len 8 \\
      --chunk_size 500000 \\
      --undersample   # optional: undersample browse_only to 3× minority
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
from collections import defaultdict
from typing import Dict, List, Tuple

import numpy as np
import torch

# ── vocab ──────────────────────────────────────────────────────────────────
SPECIAL_TOKENS: Dict[str, int] = {
    "[PAD]": 0,
    "[UNK]": 1,
    "[CLS]": 2,
    "[MASK]": 3,
}

# Coveo product_action  →  GhostTracker event token
ACTION_MAP: Dict[str, str] = {
    "detail":   "page_view",
    "add":      "add_to_cart",
    "remove":   "cart_remove",
    "purchase": "conversion_event",
}

PAGEVIEW_TOKEN = "page_browse"   # event_type == pageview, no product action

GHOSTTRACKER_TOKENS = [
    "page_view",
    "page_browse",
    "add_to_cart",
    "cart_remove",
    "conversion_event",
]

# Build vocab: special + ghosttracker tokens
VOCAB: Dict[str, int] = dict(SPECIAL_TOKENS)
for _t in GHOSTTRACKER_TOKENS:
    if _t not in VOCAB:
        VOCAB[_t] = len(VOCAB)

# Label mapping
LABEL_MAP: Dict[str, int] = {
    "conversion":   0,
    "cart_abandon": 1,
    "browse_only":  2,
    "bounce":       3,
}

# ── helpers ────────────────────────────────────────────────────────────────

def row_to_token(event_type: str, product_action: str) -> str:
    """Convert one CSV row to a single GhostTracker event token."""
    if product_action and product_action in ACTION_MAP:
        return ACTION_MAP[product_action]
    return PAGEVIEW_TOKEN


def derive_label(actions: List[str]) -> str:
    """
    actions = list of raw product_action values in the session (may be empty).
    """
    action_set = set(a for a in actions if a)
    if "purchase" in action_set:
        return "conversion"
    if "add" in action_set:
        return "cart_abandon"
    return "bounce"   # will be upgraded to browse_only below if session is long enough


# id 리스트를 왼쪽 패딩 / 오른쪽 잘라내기로 max_len에 맞춘다
def pad_or_truncate(ids: List[int], max_len: int, pad_id: int = 0) -> List[int]:
    """Left-pad / right-truncate to max_len."""
    if len(ids) >= max_len:
        return ids[-max_len:]          # keep the most recent events
    return [pad_id] * (max_len - len(ids)) + ids


# PAD 위치는 0, 실제 토큰 위치는 1인 attention mask를 생성한다
def build_attention_mask(ids: List[int], pad_id: int = 0) -> List[int]:
    return [0 if i == pad_id else 1 for i in ids]


# ── main processing ────────────────────────────────────────────────────────

def load_and_group(csv_path: str, chunk_size: int) -> Dict[str, list]:
    """
    Stream browsing_train.csv in chunks → group rows by session_id_hash.
    Returns dict: session_id → list of (timestamp_ms, event_type, product_action).
    """
    sessions: Dict[str, list] = defaultdict(list)
    total = 0
    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        chunk: list = []
        for row in reader:
            chunk.append(row)
            total += 1
            if len(chunk) >= chunk_size:
                for r in chunk:
                    sessions[r["session_id_hash"]].append((
                        int(r["server_timestamp_epoch_ms"]),
                        r.get("event_type", ""),
                        r.get("product_action", ""),
                    ))
                chunk = []
                print(f"  loaded {total:,} rows …", end="\r", flush=True)
        for r in chunk:
            sessions[r["session_id_hash"]].append((
                int(r["server_timestamp_epoch_ms"]),
                r.get("event_type", ""),
                r.get("product_action", ""),
            ))
    print(f"\n  total rows: {total:,}, unique sessions: {len(sessions):,}")
    return sessions


def process_sessions(
    sessions: Dict[str, list],
    min_events: int,
    max_len: int,
) -> Tuple[List[dict], Dict[str, int]]:
    """
    Convert raw session groups into processed session records.
    Returns (records, label_counts).
    """
    records: List[dict] = []
    label_counts: Dict[str, int] = defaultdict(int)

    for sid, events in sessions.items():
        # sort by timestamp
        events.sort(key=lambda x: x[0])
        n = len(events)

        # compute time gaps (seconds) between consecutive events
        timestamps = [e[0] for e in events]
        time_gaps: List[float] = [0.0]
        for i in range(1, n):
            gap = max(0.0, (timestamps[i] - timestamps[i - 1]) / 1000.0)
            time_gaps.append(round(gap, 1))

        # map to tokens
        tokens = [row_to_token(e[1], e[2]) for e in events]
        actions = [e[2] for e in events]

        # filter short sessions first
        if n < min_events:
            continue

        # derive label
        label = derive_label(actions)
        # With min_events=3, any remaining 'bounce' (no product actions) is
        # effectively a longer browse-only session → upgrade label.
        # True bounce sessions (≤2 events) are already filtered above.
        if label == "bounce":
            label = "browse_only"

        # token → id
        token_ids = [VOCAB.get(t, VOCAB["[UNK]"]) for t in tokens]

        # truncate / pad
        token_ids_padded = pad_or_truncate(token_ids, max_len)
        time_gaps_padded = pad_or_truncate(
            [int(g) for g in time_gaps], max_len, pad_id=0
        )
        attn_mask = build_attention_mask(token_ids_padded)

        records.append({
            "session_id":    sid,
            "tokens":        " ".join(tokens[-max_len:]),
            "token_ids":     token_ids_padded,
            "time_gaps":     time_gaps_padded,
            "attn_mask":     attn_mask,
            "label_str":     label,
            "label_id":      LABEL_MAP[label],
            "raw_len":       n,
        })
        label_counts[label] += 1

    return records, dict(label_counts)


# browse_only 클래스를 소수 클래스의 factor배로 다운샘플해 불균형을 완화한다
def undersample(records: List[dict], factor: int = 3) -> List[dict]:
    """
    Keep all minority classes; downsample browse_only to factor × max(minority).
    """
    minority = [r for r in records if r["label_str"] != "browse_only"]
    majority = [r for r in records if r["label_str"] == "browse_only"]
    minority_count = len(minority)
    target = min(len(majority), factor * minority_count)
    random.shuffle(majority)
    return minority + majority[:target]


# 클래스별 샘플 수와 역빈도 기반 class weight를 콘솔에 출력한다
def print_class_distribution(label_counts: Dict[str, int]) -> None:
    total = sum(label_counts.values())
    print("\n── Class distribution ──────────────────")
    for lbl, cnt in sorted(label_counts.items(), key=lambda x: -x[1]):
        print(f"  {lbl:15s} {cnt:8,}  ({100*cnt/total:.1f}%)")
    print(f"  {'TOTAL':15s} {total:8,}")

    # suggest inverse-frequency weights
    weights = {lbl: total / (len(label_counts) * cnt) for lbl, cnt in label_counts.items()}
    ordered = [weights.get(lbl, 1.0) for lbl in sorted(LABEL_MAP, key=LABEL_MAP.get)]
    ordered_norm = [w / min(ordered) for w in ordered]
    print("\n── Suggested class weights (for CrossEntropyLoss) ──")
    for lbl, wt in zip(sorted(LABEL_MAP, key=LABEL_MAP.get), ordered_norm):
        print(f"  label {LABEL_MAP[lbl]} ({lbl:15s})  weight = {wt:.3f}")
    print(f"\n  torch.tensor({[round(w,3) for w in ordered_norm]})")


# 전처리 결과를 CSV·PyTorch .pt·vocab JSON 세 가지 형식으로 저장한다
def save_outputs(
    records: List[dict],
    outdir: str,
    max_len: int,
) -> None:
    os.makedirs(outdir, exist_ok=True)

    # ── CSV (human-readable) ──────────────────────────────────────────────
    csv_path = os.path.join(outdir, "coveo_processed.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["session_id", "label_str", "label_id",
                        "raw_len", "tokens", "token_ids", "time_gaps", "attn_mask"],
        )
        writer.writeheader()
        for r in records:
            writer.writerow({
                "session_id": r["session_id"],
                "label_str":  r["label_str"],
                "label_id":   r["label_id"],
                "raw_len":    r["raw_len"],
                "tokens":     r["tokens"],
                "token_ids":  " ".join(map(str, r["token_ids"])),
                "time_gaps":  " ".join(map(str, r["time_gaps"])),
                "attn_mask":  " ".join(map(str, r["attn_mask"])),
            })
    print(f"\n  saved CSV  → {csv_path}")

    # ── PyTorch tensors ───────────────────────────────────────────────────
    token_tensor = torch.tensor(
        [r["token_ids"] for r in records], dtype=torch.long
    )
    gap_tensor = torch.tensor(
        [r["time_gaps"] for r in records], dtype=torch.float32
    )
    mask_tensor = torch.tensor(
        [r["attn_mask"] for r in records], dtype=torch.long
    )
    label_tensor = torch.tensor(
        [r["label_id"] for r in records], dtype=torch.long
    )
    sid_list = [r["session_id"] for r in records]

    pt_path = os.path.join(outdir, "coveo_dataset.pt")
    torch.save(
        {
            "token_ids":   token_tensor,   # (N, max_len)
            "time_gaps":   gap_tensor,     # (N, max_len)
            "attn_mask":   mask_tensor,    # (N, max_len)
            "labels":      label_tensor,   # (N,)
            "session_ids": sid_list,
            "vocab":       VOCAB,
            "label_map":   LABEL_MAP,
            "max_len":     max_len,
        },
        pt_path,
    )
    print(f"  saved .pt  → {pt_path}")

    # ── vocab JSON ────────────────────────────────────────────────────────
    vocab_path = os.path.join(outdir, "coveo_vocab.json")
    with open(vocab_path, "w", encoding="utf-8") as fh:
        json.dump({"vocab": VOCAB, "label_map": LABEL_MAP}, fh, indent=2, ensure_ascii=False)
    print(f"  saved vocab → {vocab_path}")


# ── entry point ─────────────────────────────────────────────────────────────

# CLI 인자를 파싱해 Namespace로 반환한다
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Preprocess Coveo SIGIR 2021 for GhostTracker")
    p.add_argument("--input",       default="../SIGIR-ecom-data-challenge/train/browsing_train.csv")
    p.add_argument("--outdir",      default="output/coveo")
    p.add_argument("--min_events",  type=int, default=3,
                   help="Minimum events per session (default 3)")
    p.add_argument("--max_len",     type=int, default=8,
                   help="Max sequence length, p95 value (default 8)")
    p.add_argument("--chunk_size",  type=int, default=500_000,
                   help="Rows per chunk when reading CSV (default 500k)")
    p.add_argument("--undersample", action="store_true",
                   help="Undersample browse_only to 3× minority classes")
    p.add_argument("--seed",        type=int, default=42)
    return p.parse_args()


# 로드 → 세션 처리 → (선택)언더샘플 → 저장 순서로 전처리 파이프라인을 실행한다
def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)

    print("=" * 60)
    print("  Coveo SIGIR 2021  →  GhostTracker session dataset")
    print("=" * 60)
    print(f"  input      : {args.input}")
    print(f"  min_events : {args.min_events}")
    print(f"  max_len    : {args.max_len}")
    print(f"  undersample: {args.undersample}")
    print()

    # Step 1: load & group
    print("[1/4] Loading and grouping events …")
    sessions = load_and_group(args.input, args.chunk_size)

    # Step 2-4: process
    print("[2/4] Processing sessions (label derivation + tokenisation) …")
    records, label_counts = process_sessions(sessions, args.min_events, args.max_len)
    print(f"  processed sessions: {len(records):,}")
    print_class_distribution(label_counts)

    # Step 5: optional undersampling
    if args.undersample:
        print("\n[3/4] Undersampling browse_only …")
        before = len(records)
        records = undersample(records, factor=3)
        after_counts: Dict[str, int] = defaultdict(int)
        for r in records:
            after_counts[r["label_str"]] += 1
        print(f"  {before:,} → {len(records):,} sessions")
        print_class_distribution(dict(after_counts))
    else:
        print("\n[3/4] Skipping undersampling (use --undersample to enable)")

    # Step 6: save
    print("\n[4/4] Saving outputs …")
    save_outputs(records, args.outdir, args.max_len)

    print("\n✓ Preprocessing complete.")
    print(f"  Next step:  python train_sasrec.py --data {args.outdir}/coveo_dataset.pt")


if __name__ == "__main__":
    main()
