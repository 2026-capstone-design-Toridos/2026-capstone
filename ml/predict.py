import joblib
import pandas as pd
import glob

# ======================
# 1. 모델 로드
# ======================
model = joblib.load("model.pkl")

# ======================
# 2. 최신 feature 파일 자동 로드
# ======================
files = glob.glob("ml/output/session_features_*.csv")
latest_file = max(files)

print("사용 데이터:", latest_file)

df = pd.read_csv(latest_file)

# ======================
# 3. 전처리 (train이랑 동일하게!!)
# ======================
if 'session_id' in df.columns:
    df = df.drop(columns=['session_id'])

df = pd.get_dummies(df)

# ⚠️ train 때 컬럼 맞추기 필요 (중요!)
# 간단 버전: 부족한 컬럼 0으로 채우기
model_features = model.get_booster().feature_names

for col in model_features:
    if col not in df.columns:
        df[col] = 0

df = df[model_features]

# ======================
# 4. 예측
# ======================
probs = model.predict_proba(df)[:, 1]

# ======================
# 5. 출력
# ======================
for i, p in enumerate(probs[:10]):  # 상위 10개만 출력
    print(f"[Session {i}] 이탈 확률: {p*100:.2f}%")