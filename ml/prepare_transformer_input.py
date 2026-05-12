"""
prepare_transformer_input.py

session_semantic_sequences_*.csv 파일을 읽어서
Transformer 학습용 입력 텐서로 변환한다.

입력:
  output/session_semantic_sequences_*.csv

출력:
  output/transformer_input.pt
  output/vocab.json
  output/session_meta.csv

역할:
  1. sequence 문자열 읽기
  2. 너무 짧은 세션 제거
  3. vocab 생성
  4. token -> id 변환
  5. max_len 기준 truncate / padding
  6. attention_mask 생성
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter
from typing import Dict, List, Tuple

import torch


SPECIAL_TOKENS = {
    "PAD": "[PAD]",
    "UNK": "[UNK]",
    "MASK": "[MASK]",
    "CLS": "[CLS]",
}


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def load_sequences(csv_path: str) -> List[Dict]:
    """
    build_session_sequences.py가 만든 CSV를 읽는다.

    CSV columns:
      session_id,start_timestamp,end_timestamp,length,sequence
    """
    rows = []

    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)

        for row in reader:
            sequence_text = row.get("sequence", "").strip()
            tokens = sequence_text.split() if sequence_text else []

            try:
                length = int(float(row.get("length", len(tokens))))
            except ValueError:
                length = len(tokens)

            rows.append({
                "session_id": row.get("session_id"),
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "length": length,
                "tokens": tokens,
            })

    return rows


def filter_sequences(rows: List[Dict], min_len: int) -> List[Dict]:
    """
    너무 짧은 세션 제거.
    Transformer / clustering에는 길이 1~2짜리 세션은 노이즈가 되기 쉬움.
    """
    return [row for row in rows if len(row["tokens"]) >= min_len]


def build_vocab(rows: List[Dict], min_freq: int = 1) -> Dict[str, int]:
    counter = Counter()

    for row in rows:
        counter.update(row["tokens"])

    vocab = {}

    # special token ids 고정
    vocab[SPECIAL_TOKENS["PAD"]] = 0
    vocab[SPECIAL_TOKENS["UNK"]] = 1
    vocab[SPECIAL_TOKENS["MASK"]] = 2
    vocab[SPECIAL_TOKENS["CLS"]] = 3

    next_id = len(vocab)

    for token, count in counter.most_common():
        if count < min_freq:
            continue

        if token not in vocab:
            vocab[token] = next_id
            next_id += 1

    return vocab


def encode_sequence(
    tokens: List[str],
    vocab: Dict[str, int],
    max_len: int,
    use_cls: bool = True,
    truncate_side: str = "right",
) -> Tuple[List[int], List[int], List[str]]:
    """
    token sequence를 id sequence로 변환.

    truncate_side:
      - "right": 앞쪽 max_len 사용
      - "left": 뒤쪽 max_len 사용
        이탈/구매 직전 행동을 보고 싶으면 left 추천.
    """
    cls_token = SPECIAL_TOKENS["CLS"]
    pad_id = vocab[SPECIAL_TOKENS["PAD"]]
    unk_id = vocab[SPECIAL_TOKENS["UNK"]]
    cls_id = vocab[cls_token]

    processed = list(tokens)

    if use_cls:
        # CLS를 넣을 공간을 남긴다.
        content_max_len = max_len - 1
    else:
        content_max_len = max_len

    if len(processed) > content_max_len:
        if truncate_side == "left":
            # 마지막 행동 보존
            processed = processed[-content_max_len:]
        else:
            # 초반 행동 보존
            processed = processed[:content_max_len]

    if use_cls:
        processed = [cls_token] + processed

    input_ids = [vocab.get(token, unk_id) for token in processed]
    attention_mask = [1] * len(input_ids)

    while len(input_ids) < max_len:
        input_ids.append(pad_id)
        attention_mask.append(0)

    return input_ids, attention_mask, processed


def save_vocab(vocab: Dict[str, int], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(vocab, f, ensure_ascii=False, indent=2)


def save_meta(rows: List[Dict], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "session_id",
                "start_timestamp",
                "end_timestamp",
                "original_length",
                "used_length",
                "sequence",
            ],
        )
        writer.writeheader()

        for row in rows:
            writer.writerow({
                "session_id": row["session_id"],
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "original_length": row.get("original_length"),
                "used_length": row.get("used_length"),
                "sequence": " ".join(row.get("used_tokens", [])),
            })


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Prepare Transformer input tensors from semantic session sequence CSV."
    )

    parser.add_argument(
        "--input",
        required=True,
        help="Path to session_semantic_sequences_*.csv",
    )

    parser.add_argument(
        "--output-dir",
        default="output/transformer",
        help="Output directory",
    )

    parser.add_argument(
        "--max-len",
        type=int,
        default=128,
        help="Maximum sequence length including [CLS]",
    )

    parser.add_argument(
        "--min-len",
        type=int,
        default=5,
        help="Minimum sequence length before filtering",
    )

    parser.add_argument(
        "--min-freq",
        type=int,
        default=1,
        help="Minimum token frequency for vocab",
    )

    parser.add_argument(
        "--truncate-side",
        choices=["left", "right"],
        default="left",
        help="left keeps last tokens, right keeps first tokens",
    )

    parser.add_argument(
        "--no-cls",
        action="store_true",
        help="Do not prepend [CLS] token",
    )

    args = parser.parse_args()

    ensure_dir(args.output_dir)

    rows = load_sequences(args.input)
    original_session_count = len(rows)

    rows = filter_sequences(rows, min_len=args.min_len)
    filtered_session_count = len(rows)

    if not rows:
        raise ValueError("No sessions left after filtering. Lower --min-len.")

    vocab = build_vocab(rows, min_freq=args.min_freq)

    input_ids = []
    attention_masks = []
    meta_rows = []

    for row in rows:
        original_tokens = row["tokens"]

        encoded_ids, mask, used_tokens = encode_sequence(
            original_tokens,
            vocab=vocab,
            max_len=args.max_len,
            use_cls=not args.no_cls,
            truncate_side=args.truncate_side,
        )

        input_ids.append(encoded_ids)
        attention_masks.append(mask)

        meta_rows.append({
            "session_id": row["session_id"],
            "start_timestamp": row.get("start_timestamp"),
            "end_timestamp": row.get("end_timestamp"),
            "original_length": len(original_tokens),
            "used_length": int(sum(mask)),
            "used_tokens": used_tokens,
        })

    input_ids_tensor = torch.tensor(input_ids, dtype=torch.long)
    attention_mask_tensor = torch.tensor(attention_masks, dtype=torch.long)

    data = {
        "input_ids": input_ids_tensor,
        "attention_mask": attention_mask_tensor,
        "vocab": vocab,
        "config": {
            "max_len": args.max_len,
            "min_len": args.min_len,
            "min_freq": args.min_freq,
            "truncate_side": args.truncate_side,
            "use_cls": not args.no_cls,
            "pad_id": vocab[SPECIAL_TOKENS["PAD"]],
            "unk_id": vocab[SPECIAL_TOKENS["UNK"]],
            "mask_id": vocab[SPECIAL_TOKENS["MASK"]],
            "cls_id": vocab[SPECIAL_TOKENS["CLS"]],
        },
    }

    pt_path = os.path.join(args.output_dir, "transformer_input.pt")
    vocab_path = os.path.join(args.output_dir, "vocab.json")
    meta_path = os.path.join(args.output_dir, "session_meta.csv")

    torch.save(data, pt_path)
    save_vocab(vocab, vocab_path)
    save_meta(meta_rows, meta_path)

    lengths = [row["original_length"] for row in meta_rows]
    used_lengths = [row["used_length"] for row in meta_rows]

    print("\n=== Transformer Input Preparation Summary ===")
    print(f"Input CSV sessions       : {original_session_count}")
    print(f"After min_len filtering  : {filtered_session_count}")
    print(f"Vocab size               : {len(vocab)}")
    print(f"Max len                  : {args.max_len}")
    print(f"Truncate side            : {args.truncate_side}")
    print(f"Input ids shape          : {tuple(input_ids_tensor.shape)}")
    print(f"Attention mask shape     : {tuple(attention_mask_tensor.shape)}")
    print(f"Original length min/max  : {min(lengths)} / {max(lengths)}")
    print(f"Used length min/max      : {min(used_lengths)} / {max(used_lengths)}")

    print("\nSaved:")
    print(f"  PT    : {pt_path}")
    print(f"  VOCAB : {vocab_path}")
    print(f"  META  : {meta_path}")


if __name__ == "__main__":
    main()