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

  await mongoose.connect(uri);
  isConnected = true;
  console.log('[GhostTracker] MongoDB 연결 성공');
}

module.exports = { connectDB };
