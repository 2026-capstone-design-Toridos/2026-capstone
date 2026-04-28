import pandas as pd
from xgboost import XGBClassifier
from sklearn.model_selection import train_test_split
import joblib

# 데이터 로드
df = pd.read_csv("ml/output/session_features_20260427_1911.csv")

# 1. 먼저 session_id 제거
if 'session_id' in df.columns:
    df = df.drop(columns=['session_id'])

# 2. One-hot encoding
df = pd.get_dummies(df)

# 3. feature / label 분리
X = df.drop(columns=['is_churned'])
y = df['is_churned']

# 학습
X_train, X_test, y_train, y_test = train_test_split(X, y)

model = XGBClassifier()
model.fit(X_train, y_train)

# 저장
joblib.dump(model, "model.pkl")

print("모델 학습 완료")