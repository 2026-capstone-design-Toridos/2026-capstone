/**
 * db.js — GhostTracker MongoDB 연결 관리
 *
 * 역할: 서버 시작 시 MONGODB_URI로 MongoDB에 한 번만 연결하고,
 *      이미 연결된 상태에서는 중복 연결을 막는다.
 */

const mongoose = require('mongoose');

let isConnected = false;

// 서버 부팅 시 호출 — 연결 성공 후에만 Express listen을 시작한다
async function connectDB() {
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI 환경변수가 설정되지 않았습니다.');
  }

  await mongoose.connect(uri, {
    // Atlas DNS/네트워크 장애 때 기본 수십 초 동안 요청을 쌓아두지 않고
    // 빠르게 실패시켜 대시보드가 기존 값을 유지한 채 다음 갱신을 시도한다.
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    socketTimeoutMS: 10_000,
    maxPoolSize: 10,
  });
  isConnected = true;
  console.log('[GhostTracker] MongoDB 연결 성공');
}

module.exports = { connectDB };
