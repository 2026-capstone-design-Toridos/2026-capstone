const mongoose = require('mongoose');

const AgentMessageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: mongoose.Schema.Types.Mixed, required: true },
  request_id: { type: String, default: '' },
  snapshot_id: { type: String, default: '' },
  used_tools: { type: [String], default: [] },
  query_plan: { type: mongoose.Schema.Types.Mixed, default: null },
  metric_digest: { type: mongoose.Schema.Types.Mixed, default: null },
  feedback: { type: String, enum: ['', 'helpful', 'not_helpful'], default: '' },
  created_at: { type: Date, default: Date.now },
}, { _id: false });

const AgentActionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  status: { type: String, enum: ['planned', 'done'], default: 'planned' },
  created_at: { type: Date, default: Date.now },
}, { _id: true });

const AgentThreadSchema = new mongoose.Schema({
  // tenant_id는 클라이언트 입력이 아니라 requireSite가 확정한 대표 origin이다.
  tenant_id: { type: String, required: true, index: true },
  thread_id: { type: String, required: true },
  agent_name: { type: String, required: true },
  messages: { type: [AgentMessageSchema], default: [] },
  // 같은 대화의 모든 후속 질문은 이 기준시각을 재사용한다.
  // 기간을 명시적으로 바꾸거나 최신 데이터 재분석을 요청할 때만 교체된다.
  snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  saved_actions: { type: [AgentActionSchema], default: [] },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

AgentThreadSchema.index({ tenant_id: 1, thread_id: 1 }, { unique: true });

module.exports = mongoose.model('AgentThread', AgentThreadSchema);
