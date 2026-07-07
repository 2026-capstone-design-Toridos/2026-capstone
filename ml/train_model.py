"""
train_model.py — XGBoost 이탈 예측 모델 학습 스크립트

역할: etl_session_features.py로 추출한 session_features CSV를 읽어
     XGBClassifier로 is_churned 이진 분류 모델을 학습하고 model.pkl로 저장한다.
     초기 실험용으로, 현재 운영 분류는 cluster_server.py가 담당한다.
"""

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