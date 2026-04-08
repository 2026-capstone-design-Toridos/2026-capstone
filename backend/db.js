const mongoose = require('mongoose');

let isConnected = false;

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
