const mongoose = require('mongoose');    // mongoose 라이브러리를 가져옴

let isConnected = false;                // MongoDB 연결 상태를 추적하기 위한 변수

async function connectDB() {            // MongoDB 연결 함수로 이미 연결되어 있는 경우에는 연결을 시도하지 않음
  if (isConnected) return;

  const uri = process.env.MONGODB_URI;  // 환경변수에서 MongoDB URI를 가져옴
  if (!uri) {
    throw new Error('MONGODB_URI 환경변수가 설정되지 않았습니다.'); 
  }

  await mongoose.connect(uri);          // MongoDB에 연결
  isConnected = true;                   // 연결이 완료 되었으니 변수를 true로 설정
  console.log('[GhostTracker] MongoDB 연결 성공');  // 연결 성공 로그 출력
}

module.exports = { connectDB };         // connectDB 함수를 모듈로 내보냄
