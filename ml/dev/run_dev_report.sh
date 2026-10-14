#!/usr/bin/env bash
# 로컬 개발용: 샘플 CSV로 보고서를 만든다. 실제 DB/서버 없이 동작한다.
# 사용: cd ml && bash dev/run_dev_report.sh
# 결과: ml/dev/out/dev.html (PDF 변환이 되면 dev.pdf도 생성)
set -e
cd "$(dirname "$0")/.."
PY="${PYTHON:-python3}"
"$PY" report_html.py \
  --origin https://dignolucir.co.kr \
  --result-csv dev/sample_result.csv --metrics-json dev/sample_metrics.json \
  --start 2026-10-04 --end 2026-10-10 \
  --output dev/out/dev.pdf
echo "HTML: $(pwd)/dev/out/dev.html"
