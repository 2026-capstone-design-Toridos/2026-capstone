"""
convert_teammate_data.py
------------------------
팀원의 transformer_input.pt 파일을 우리 vocab 기준으로 재인코딩하여
Colab 사전학습 데이터(CSV)로 변환한다.

사용법:
  python convert_teammate_data.py
  python convert_teammate_data.py --input transformer_input.pt --output output/teammate_sessions.csv

출력: ml/output/teammate_sessions.csv
  → Colab에서 COVEO_CSV 대신 또는 추가 사전학습 데이터로 사용
"""

import argparse, csv, json, os
import torch

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
META_PATH = os.path.join(BASE_DIR, 'output/unsupervised_semantic/cluster_meta.json')

# 팀원 전용 토큰 → 우리 vocab 최근접 수동 매핑
MANUAL_MAP = {
    'CART|CHECK_PRICE|CLICK':           'CART|CHECK_PRICE|HOVER_SHORT',
    'CART|CHECK_PRICE|DWELL_MEDIUM':    'CART|CHECK_PRICE|HOVER_SHORT',
    'CART|CHECK_SHIPPING|CLICK':        'CART|CHECK_SHIPPING|HOVER_SHORT',
    'CART|CHECK_SHIPPING|DWELL_MEDIUM': 'CART|CHECK_SHIPPING|HOVER_SHORT',
    'PRODUCT|CHECK_PRICE|DWELL_MEDIUM': 'PRODUCT|CHECK_PRICE|HOVER_SHORT',
    'PRODUCT|CHECK_SIZE|SELECT':        'PRODUCT|CHECK_SIZE|HOVER_SHORT',
    'PRODUCT|VIEW_REVIEW|DWELL_LONG':   'PRODUCT|VIEW_REVIEW|HOVER_SHORT',
    'PRODUCT|VIEW_REVIEW|DWELL_MEDIUM': 'PRODUCT|VIEW_REVIEW|HOVER_SHORT',
    # 아래는 우리 vocab에 없어서 UNK 처리
    'CART|CART_ABANDON|RISK':     '[UNK]',
    'CART|EXIT_SESSION|NONE':     'CART|ENTER_CART|NONE',   # 근사 대체
    'CATEGORY|ENTER_CATEGORY|NONE':   'CATEGORY|ENTER_CATEGORY|NONE',  # 동일
    'CATEGORY|SCROLL_CATEGORY|SCROLL_MID': 'CATEGORY|SCROLL_CATEGORY|SCROLL_MID',
    'CHECKOUT|EXIT_SESSION|NONE': 'CHECKOUT|ENTER_CHECKOUT|NONE',
    'CHECKOUT|PURCHASE|DONE':     'CHECKOUT|CLICK_BUY|NONE',  # 근사 대체
    'PRODUCT|CHANGE_OPTION|CHANGE_ONCE': 'PRODUCT|CHANGE_OPTION|NONE',
    'PRODUCT|EXIT_SESSION|NONE':  'PRODUCT|VIEW_PRODUCT|DWELL_SHORT',
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input',  default='transformer_input.pt',
                        help='팀원 .pt 파일 경로')
    parser.add_argument('--output', default='output/teammate_sessions.csv',
                        help='출력 CSV 경로')
    parser.add_argument('--min_len', type=int, default=4,
                        help='최소 시퀀스 길이')
    parser.add_argument('--max_sessions', type=int, default=0,
                        help='변환할 최대 세션 수 (0=전체)')
    args = parser.parse_args()

    # 우리 vocab 로드
    print('우리 vocab 로드 중...')
    with open(META_PATH, encoding='utf-8') as f:
        meta = json.load(f)
    our_vocab = meta['vocab']
    PAD_ID = meta['special_tokens']['PAD_ID']   # 0
    print(f'  vocab size: {len(our_vocab)}')

    # 팀원 데이터 로드
    print(f'\n팀원 데이터 로드 중: {args.input}')
    data = torch.load(args.input, map_location='cpu', weights_only=False)
    input_ids    = data['input_ids']     # (N, 128)
    teammate_vocab = data['vocab']
    id2tok = {v: k for k, v in teammate_vocab.items()}

    total = len(input_ids)
    limit = args.max_sessions if args.max_sessions > 0 else total
    print(f'  총 세션: {total:,}개 → {min(total, limit):,}개 변환 예정')

    # 변환
    os.makedirs(os.path.dirname(args.output) if os.path.dirname(args.output) else '.', exist_ok=True)

    converted, skipped, unk_count = 0, 0, 0

    with open(args.output, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['session_id','start_timestamp','end_timestamp','length','sequence'])
        writer.writeheader()

        for i in range(min(total, limit)):
            ids = input_ids[i]
            # PAD 제거 & 토큰 문자열 복원
            tokens_str = []
            for tid in ids.tolist():
                if tid == 0:   # PAD
                    continue
                tok = id2tok.get(tid, '[UNK]')
                if tok in ('[PAD]', '[CLS]', '[UNK]', '[MASK]'):
                    continue
                # 우리 vocab으로 변환
                if tok in our_vocab:
                    tokens_str.append(tok)
                elif tok in MANUAL_MAP:
                    mapped = MANUAL_MAP[tok]
                    if mapped == '[UNK]':
                        unk_count += 1
                    else:
                        tokens_str.append(mapped)
                else:
                    unk_count += 1   # 매핑 실패 → 스킵

            if len(tokens_str) < args.min_len:
                skipped += 1
                continue

            writer.writerow({
                'session_id':      f'teammate_{i:06d}',
                'start_timestamp': '',
                'end_timestamp':   '',
                'length':          len(tokens_str),
                'sequence':        ' '.join(tokens_str),
            })
            converted += 1

            if converted % 10000 == 0:
                print(f'  변환 중... {converted:,}/{min(total, limit):,}')

    print(f'\n✅ 완료!')
    print(f'   변환 성공: {converted:,}개')
    print(f'   스킵 (너무 짧음): {skipped:,}개')
    print(f'   UNK 처리된 토큰: {unk_count:,}개')
    print(f'   출력: {args.output}')
    print(f'\n📌 Colab 사용법:')
    print(f'   1. {args.output} 파일을 Google Drive GhostTracker/ 에 업로드')
    print(f'   2. colab_pretrain_cluster.ipynb Cell 3에서:')
    print(f'      COVEO_CSV = f\'{{BASE}}/teammate_sessions.csv\'')
    print(f'   또는 Coveo와 병합해서 사용 가능')


if __name__ == '__main__':
    main()
