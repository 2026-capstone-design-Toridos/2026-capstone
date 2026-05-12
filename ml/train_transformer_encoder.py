"""
train_transformer_encoder.py

prepare_transformer_input.py가 만든 transformer_input.pt를 읽어서
Transformer Encoder를 Masked Token Prediction 방식으로 학습하고,
세션 임베딩을 생성한다.

입력:
  output/transformer/transformer_input.pt

출력:
  output/transformer/session_embeddings.npy
  output/transformer/session_embedding_meta.csv
  output/transformer/transformer_encoder.pt
"""

from __future__ import annotations

import argparse
import csv
import os
import random
from typing import Tuple

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, TensorDataset


class SessionTransformerEncoder(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        max_len: int,
        pad_id: int,
        embed_dim: int = 64,
        num_heads: int = 4,
        num_layers: int = 2,
        ff_dim: int = 128,
        dropout: float = 0.1,
    ):
        super().__init__()

        self.pad_id = pad_id
        self.max_len = max_len
        self.embed_dim = embed_dim

        self.token_embedding = nn.Embedding(
            vocab_size,
            embed_dim,
            padding_idx=pad_id,
        )

        self.position_embedding = nn.Embedding(
            max_len,
            embed_dim,
        )

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim,
            nhead=num_heads,
            dim_feedforward=ff_dim,
            dropout=dropout,
            batch_first=True,
            activation="gelu",
        )

        self.encoder = nn.TransformerEncoder(
            encoder_layer,
            num_layers=num_layers,
        )

        self.output_head = nn.Linear(embed_dim, vocab_size)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor):
        """
        input_ids:      (B, L)
        attention_mask: (B, L), 1=valid, 0=pad
        """
        batch_size, seq_len = input_ids.shape

        positions = torch.arange(seq_len, device=input_ids.device)
        positions = positions.unsqueeze(0).expand(batch_size, seq_len)

        token_emb = self.token_embedding(input_ids)
        pos_emb = self.position_embedding(positions)

        x = token_emb + pos_emb

        # PyTorch Transformer는 True가 mask 대상임
        key_padding_mask = attention_mask == 0

        encoded = self.encoder(
            x,
            src_key_padding_mask=key_padding_mask,
        )

        logits = self.output_head(encoded)

        return logits, encoded

    def encode(self, input_ids: torch.Tensor, attention_mask: torch.Tensor, pooling: str = "mean"):
        """
        세션 임베딩 생성.
        pooling:
          - cls: 첫 번째 [CLS] 토큰 사용
          - mean: pad 제외 평균 pooling
        """
        _, encoded = self.forward(input_ids, attention_mask)

        if pooling == "cls":
            return encoded[:, 0, :]

        # mean pooling
        mask = attention_mask.unsqueeze(-1).float()
        summed = (encoded * mask).sum(dim=1)
        denom = mask.sum(dim=1).clamp(min=1e-8)
        return summed / denom


def set_seed(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def create_masked_inputs(
    input_ids: torch.Tensor,
    attention_mask: torch.Tensor,
    mask_id: int,
    pad_id: int,
    cls_id: int,
    mask_prob: float = 0.15,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """
    BERT식 Masked Token Prediction용 입력 생성.

    labels:
      - 예측해야 하는 위치: 원래 token id
      - 예측 안 하는 위치: -100
    """
    masked_input_ids = input_ids.clone()
    labels = torch.full_like(input_ids, fill_value=-100)

    # PAD, CLS는 마스킹하지 않음
    can_mask = (attention_mask == 1) & (input_ids != pad_id) & (input_ids != cls_id)

    random_values = torch.rand(input_ids.shape, device=input_ids.device)
    mask_positions = (random_values < mask_prob) & can_mask

    labels[mask_positions] = input_ids[mask_positions]
    masked_input_ids[mask_positions] = mask_id

    return masked_input_ids, labels


def load_meta(meta_path: str):
    rows = []

    with open(meta_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    return rows


def save_embedding_meta(meta_rows, cluster_ready_path):
    with open(cluster_ready_path, "w", encoding="utf-8-sig", newline="") as f:
        fieldnames = [
            "session_id",
            "start_timestamp",
            "end_timestamp",
            "original_length",
            "used_length",
            "sequence",
        ]

        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for row in meta_rows:
            writer.writerow({
                "session_id": row.get("session_id"),
                "start_timestamp": row.get("start_timestamp"),
                "end_timestamp": row.get("end_timestamp"),
                "original_length": row.get("original_length"),
                "used_length": row.get("used_length"),
                "sequence": row.get("sequence"),
            })


def train(args):
    set_seed(args.seed)

    os.makedirs(args.output_dir, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() and not args.cpu else "cpu")
    print(f"Device: {device}")

    data = torch.load(args.input, map_location="cpu")

    input_ids = data["input_ids"]
    attention_mask = data["attention_mask"]
    vocab = data["vocab"]
    config = data["config"]

    vocab_size = len(vocab)
    max_len = config["max_len"]
    pad_id = config["pad_id"]
    mask_id = config["mask_id"]
    cls_id = config["cls_id"]

    print("\n=== Loaded Transformer Input ===")
    print(f"input_ids shape      : {tuple(input_ids.shape)}")
    print(f"attention_mask shape : {tuple(attention_mask.shape)}")
    print(f"vocab size           : {vocab_size}")
    print(f"max_len              : {max_len}")

    dataset = TensorDataset(input_ids, attention_mask)
    loader = DataLoader(
        dataset,
        batch_size=args.batch_size,
        shuffle=True,
    )

    model = SessionTransformerEncoder(
        vocab_size=vocab_size,
        max_len=max_len,
        pad_id=pad_id,
        embed_dim=args.embed_dim,
        num_heads=args.num_heads,
        num_layers=args.num_layers,
        ff_dim=args.ff_dim,
        dropout=args.dropout,
    ).to(device)

    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.lr,
        weight_decay=args.weight_decay,
    )

    criterion = nn.CrossEntropyLoss(ignore_index=-100)

    print("\n=== Start Training ===")
    print(f"epochs     : {args.epochs}")
    print(f"batch_size : {args.batch_size}")
    print(f"embed_dim  : {args.embed_dim}")
    print(f"layers     : {args.num_layers}")
    print(f"heads      : {args.num_heads}")

    model.train()

    for epoch in range(1, args.epochs + 1):
        total_loss = 0.0
        total_batches = 0

        for batch_input_ids, batch_attention_mask in loader:
            batch_input_ids = batch_input_ids.to(device)
            batch_attention_mask = batch_attention_mask.to(device)

            masked_input_ids, labels = create_masked_inputs(
                batch_input_ids,
                batch_attention_mask,
                mask_id=mask_id,
                pad_id=pad_id,
                cls_id=cls_id,
                mask_prob=args.mask_prob,
            )

            logits, _ = model(masked_input_ids, batch_attention_mask)

            loss = criterion(
                logits.view(-1, vocab_size),
                labels.view(-1),
            )

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item()
            total_batches += 1

        avg_loss = total_loss / max(total_batches, 1)

        if epoch == 1 or epoch % args.log_every == 0 or epoch == args.epochs:
            print(f"Epoch {epoch:03d} | loss = {avg_loss:.4f}")

    # 세션 임베딩 생성
    print("\n=== Generate Session Embeddings ===")

    model.eval()
    embeddings = []

    with torch.no_grad():
        for start in range(0, input_ids.shape[0], args.batch_size):
            batch_input_ids = input_ids[start:start + args.batch_size].to(device)
            batch_attention_mask = attention_mask[start:start + args.batch_size].to(device)

            batch_embeddings = model.encode(
                batch_input_ids,
                batch_attention_mask,
                pooling=args.pooling,
            )

            embeddings.append(batch_embeddings.cpu().numpy())

    embeddings = np.concatenate(embeddings, axis=0)

    embedding_path = os.path.join(args.output_dir, "session_embeddings.npy")
    model_path = os.path.join(args.output_dir, "transformer_encoder.pt")
    meta_input_path = os.path.join(os.path.dirname(args.input), "session_meta.csv")
    meta_output_path = os.path.join(args.output_dir, "session_embedding_meta.csv")

    np.save(embedding_path, embeddings)

    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "model_config": {
                "vocab_size": vocab_size,
                "max_len": max_len,
                "pad_id": pad_id,
                "embed_dim": args.embed_dim,
                "num_heads": args.num_heads,
                "num_layers": args.num_layers,
                "ff_dim": args.ff_dim,
                "dropout": args.dropout,
            },
            "vocab": vocab,
            "input_config": config,
        },
        model_path,
    )

    if os.path.exists(meta_input_path):
        meta_rows = load_meta(meta_input_path)
        save_embedding_meta(meta_rows, meta_output_path)

    print("\n=== Saved ===")
    print(f"Embeddings : {embedding_path}")
    print(f"Model      : {model_path}")
    print(f"Meta       : {meta_output_path}")
    print(f"Embedding shape: {embeddings.shape}")


def main():
    parser = argparse.ArgumentParser(
        description="Train Transformer Encoder for GhostTracker session modeling."
    )

    parser.add_argument(
        "--input",
        default="output/transformer/transformer_input.pt",
        help="Path to transformer_input.pt",
    )

    parser.add_argument(
        "--output-dir",
        default="output/transformer",
        help="Output directory",
    )

    parser.add_argument("--embed-dim", type=int, default=64)
    parser.add_argument("--num-heads", type=int, default=4)
    parser.add_argument("--num-layers", type=int, default=2)
    parser.add_argument("--ff-dim", type=int, default=128)
    parser.add_argument("--dropout", type=float, default=0.1)

    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--mask-prob", type=float, default=0.15)

    parser.add_argument("--pooling", choices=["mean", "cls"], default="mean")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--log-every", type=int, default=5)
    parser.add_argument("--cpu", action="store_true")

    args = parser.parse_args()
    train(args)


if __name__ == "__main__":
    main()