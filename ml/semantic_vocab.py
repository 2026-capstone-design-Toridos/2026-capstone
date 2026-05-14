# PAGE|SEMANTIC|CONTEXTUAL 문자열 시퀀스
# → semantic token vocab 생성
# → token_id sequence 생성
# → vocab.json / encoded_sequences.jsonl / encoded_sequences.csv 저장

# 실제 데이터를 넣고 돌리면 토큰 번호가 붙어짐=실험해봐야함
# 1. semantic_event_mapper.py에서 변환 규칙 작성
# 2. 실제 raw event 로그로 build_session_sequences.py 실행
# 3. 어떤 semantic token들이 실제로 나오는지 확인
# 4. semantic_vocab.py로 자동 vocab 생성
# 5. token_id sequence로 모델 학습

"""
semantic_vocab.py

build_session_sequences.py가 만든 PAGE|SEMANTIC|CONTEXTUAL 문자열 시퀀스를
모델 입력용 token_id sequence로 변환한다.

입력 예시:
  session_semantic_sequences_20260511_1530.csv
  session_semantic_sequences_20260511_1530.jsonl

문자열 sequence:
  PRODUCT|VIEW_PRODUCT|CLICK PRODUCT|SCROLL_REVIEW|SCROLL_HIGH

출력:
  semantic_vocab.json
  session_token_id_sequences.csv
  session_token_id_sequences.jsonl
"""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter
from datetime import datetime
from typing import Any, Dict, List, Optional


SPECIAL_TOKENS = {
    "[PAD]": 0,
    "[CLS]": 1,
    "[MASK]": 2,
    "[UNK]": 3,
}


# =========================================================
# IO Helpers
# =========================================================

def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def load_semantic_sequences(path: str) -> List[Dict[str, Any]]:
    """
    build_session_sequences.py 출력 파일을 읽는다.

    지원:
      - CSV: sequence 컬럼에 공백 구분 token 문자열
      - JSONL: sequence가 list[str] 형태
    """
    if path.endswith(".csv"):
        return load_sequences_from_csv(path)

    if path.endswith(".jsonl"):
        return load_sequences_from_jsonl(path)

    raise ValueError("지원하지 않는 입력 형식입니다. .csv 또는 .jsonl만 지원합니다.")


def load_sequences_from_csv(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)

        for row in reader:
            seq_text = row.get("sequence", "") or ""

            sequence = [
                token.strip()
                for token in seq_text.split()
                if token.strip()
            ]

            rows.append({
                "session_id": row.get("session_id"),
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "length": len(sequence),
                "sequence": sequence,
            })

    return rows


def load_sequences_from_jsonl(path: str) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()

            if not line:
                continue

            obj = json.loads(line)
            sequence = obj.get("sequence", [])

            if isinstance(sequence, str):
                sequence = [
                    token.strip()
                    for token in sequence.split()
                    if token.strip()
                ]

            if not isinstance(sequence, list):
                sequence = []

            rows.append({
                "session_id": obj.get("session_id"),
                "start_timestamp": obj.get("start_timestamp"),
                "end_timestamp": obj.get("end_timestamp"),
                "length": len(sequence),
                "sequence": sequence,
            })

    return rows


# =========================================================
# Vocab Build
# =========================================================

def count_tokens(rows: List[Dict[str, Any]]) -> Counter:
    counter: Counter = Counter()

    for row in rows:
        for token in row.get("sequence", []):
            counter[token] += 1

    return counter


def build_vocab(
    rows: List[Dict[str, Any]],
    *,
    min_freq: int = 1,
    max_vocab_size: Optional[int] = None,
) -> Dict[str, int]:
    """
    semantic token 문자열 → 정수 ID 사전 생성.

    - special tokens는 항상 고정
    - 나머지는 빈도 높은 순, 같은 빈도면 알파벳순
    """
    counter = count_tokens(rows)

    candidates = [
        (token, freq)
        for token, freq in counter.items()
        if freq >= min_freq
    ]

    candidates.sort(key=lambda x: (-x[1], x[0]))

    vocab: Dict[str, int] = dict(SPECIAL_TOKENS)
    next_id = max(vocab.values()) + 1

    for token, _freq in candidates:
        if max_vocab_size is not None and len(vocab) >= max_vocab_size:
            break

        if token in vocab:
            continue

        vocab[token] = next_id
        next_id += 1

    return vocab


def save_vocab(
    vocab: Dict[str, int],
    rows: List[Dict[str, Any]],
    output_path: str,
    *,
    min_freq: int,
    max_vocab_size: Optional[int],
) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    counter = count_tokens(rows)

    id_to_token = {
        str(idx): token
        for token, idx in vocab.items()
    }

    payload = {
        "description": "Semantic token vocabulary for PAGE|SEMANTIC|CONTEXTUAL GhostTracker sequences.",
        "format": "PAGE|SEMANTIC|CONTEXTUAL",
        "special_tokens": SPECIAL_TOKENS,
        "min_freq": min_freq,
        "max_vocab_size": max_vocab_size,
        "vocab_size": len(vocab),
        "token_to_id": vocab,
        "id_to_token": id_to_token,
        "token_freq": {
            token: counter[token]
            for token in vocab
            if token not in SPECIAL_TOKENS
        },
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def load_vocab(path: str) -> Dict[str, int]:
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if "token_to_id" in payload:
        return {
            token: int(idx)
            for token, idx in payload["token_to_id"].items()
        }

    return {
        token: int(idx)
        for token, idx in payload.items()
    }


# =========================================================
# Encoding
# =========================================================

def encode_sequence(
    sequence: List[str],
    vocab: Dict[str, int],
    *,
    add_cls: bool = True,
    max_len: Optional[int] = None,
    pad_to_max_len: bool = False,
) -> List[int]:
    """
    문자열 token sequence를 token_id sequence로 변환.

    add_cls=True:
      [CLS] token을 맨 앞에 붙임.

    max_len:
      길이 제한. add_cls 포함 길이 기준.

    pad_to_max_len=True:
      max_len까지 [PAD]로 채움.
    """
    unk_id = vocab["[UNK]"]
    pad_id = vocab["[PAD]"]

    ids: List[int] = []

    if add_cls:
        ids.append(vocab["[CLS]"])

    ids.extend(vocab.get(token, unk_id) for token in sequence)

    if max_len is not None:
        ids = ids[:max_len]

        if pad_to_max_len and len(ids) < max_len:
            ids.extend([pad_id] * (max_len - len(ids)))

    return ids


def encode_rows(
    rows: List[Dict[str, Any]],
    vocab: Dict[str, int],
    *,
    add_cls: bool = True,
    max_len: Optional[int] = None,
    pad_to_max_len: bool = False,
) -> List[Dict[str, Any]]:
    encoded: List[Dict[str, Any]] = []

    for row in rows:
        sequence = row.get("sequence", [])
        token_ids = encode_sequence(
            sequence,
            vocab,
            add_cls=add_cls,
            max_len=max_len,
            pad_to_max_len=pad_to_max_len,
        )

        encoded.append({
            "session_id": row.get("session_id"),
            "start_timestamp": row.get("start_timestamp"),
            "end_timestamp": row.get("end_timestamp"),
            "semantic_length": len(sequence),
            "token_id_length": len(token_ids),
            "semantic_sequence": sequence,
            "token_id_sequence": token_ids,
        })

    return encoded


def save_encoded_csv(rows: List[Dict[str, Any]], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "session_id",
                "start_timestamp",
                "end_timestamp",
                "semantic_length",
                "token_id_length",
                "semantic_sequence",
                "token_id_sequence",
            ],
        )

        writer.writeheader()

        for row in rows:
            writer.writerow({
                "session_id": row.get("session_id"),
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "semantic_length": row.get("semantic_length"),
                "token_id_length": row.get("token_id_length"),
                "semantic_sequence": " ".join(row.get("semantic_sequence", [])),
                "token_id_sequence": " ".join(map(str, row.get("token_id_sequence", []))),
            })


def save_encoded_jsonl(rows: List[Dict[str, Any]], output_path: str) -> None:
    ensure_dir(os.path.dirname(output_path) or ".")

    with open(output_path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


# =========================================================
# Reporting
# =========================================================

def print_summary(
    rows: List[Dict[str, Any]],
    vocab: Dict[str, int],
    *,
    min_freq: int,
) -> None:
    counter = count_tokens(rows)
    total_tokens = sum(counter.values())

    print("\n=== Semantic Vocab Summary ===")
    print(f"Sessions: {len(rows)}")
    print(f"Total semantic tokens: {total_tokens}")
    print(f"Unique semantic tokens before filtering: {len(counter)}")
    print(f"Min freq: {min_freq}")
    print(f"Final vocab size including special tokens: {len(vocab)}")

    print("\nSpecial tokens:")
    for token, idx in SPECIAL_TOKENS.items():
        print(f"  {token}: {idx}")

    print("\nTop 20 semantic tokens:")
    for token, freq in counter.most_common(20):
        token_id = vocab.get(token, vocab["[UNK]"])
        marker = "" if token in vocab else " -> [UNK]"
        print(f"  {token_id:>4} | {token}: {freq}{marker}")


# =========================================================
# CLI
# =========================================================

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build semantic token vocabulary and encode session sequences."
    )

    parser.add_argument(
        "--input",
        type=str,
        required=True,
        help="Input semantic sequence file from build_session_sequences.py. Supports .csv or .jsonl.",
    )

    parser.add_argument(
        "--output-dir",
        type=str,
        default="ml/output",
        help="Output directory.",
    )

    parser.add_argument(
        "--vocab-path",
        type=str,
        default=None,
        help="Existing vocab.json path. If provided, this vocab is used instead of building a new one.",
    )

    parser.add_argument(
        "--min-freq",
        type=int,
        default=1,
        help="Minimum token frequency to include in vocab.",
    )

    parser.add_argument(
        "--max-vocab-size",
        type=int,
        default=None,
        help="Maximum vocab size including special tokens.",
    )

    parser.add_argument(
        "--max-len",
        type=int,
        default=None,
        help="Maximum token id sequence length. Includes [CLS] if enabled.",
    )

    parser.add_argument(
        "--no-cls",
        action="store_true",
        help="Do not prepend [CLS] token.",
    )

    parser.add_argument(
        "--pad",
        action="store_true",
        help="Pad token_id_sequence to max_len. Requires --max-len.",
    )

    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    if args.pad and args.max_len is None:
        raise ValueError("--pad 옵션을 쓰려면 --max-len이 필요합니다.")

    rows = load_semantic_sequences(args.input)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    ensure_dir(args.output_dir)

    if args.vocab_path:
        vocab = load_vocab(args.vocab_path)
        vocab_output_path = args.vocab_path
    else:
        vocab = build_vocab(
            rows,
            min_freq=args.min_freq,
            max_vocab_size=args.max_vocab_size,
        )

        vocab_output_path = os.path.join(
            args.output_dir,
            f"semantic_vocab_{timestamp}.json",
        )

        save_vocab(
            vocab,
            rows,
            vocab_output_path,
            min_freq=args.min_freq,
            max_vocab_size=args.max_vocab_size,
        )

    encoded = encode_rows(
        rows,
        vocab,
        add_cls=not args.no_cls,
        max_len=args.max_len,
        pad_to_max_len=args.pad,
    )

    csv_output_path = os.path.join(
        args.output_dir,
        f"session_token_id_sequences_{timestamp}.csv",
    )
    jsonl_output_path = os.path.join(
        args.output_dir,
        f"session_token_id_sequences_{timestamp}.jsonl",
    )

    save_encoded_csv(encoded, csv_output_path)
    save_encoded_jsonl(encoded, jsonl_output_path)

    print_summary(rows, vocab, min_freq=args.min_freq)

    print("\nSaved:")
    print(f"  VOCAB : {vocab_output_path}")
    print(f"  CSV   : {csv_output_path}")
    print(f"  JSONL : {jsonl_output_path}")


if __name__ == "__main__":
    main()