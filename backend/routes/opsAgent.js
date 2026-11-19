const express = require('express');
const AgentThread = require('../models/AgentThread');
const { canonicalOrigin } = require('../middleware/siteAccess');
const { agentProfile, answerQuestion } = require('../services/opsAgentService');
const { resolveCapturePath } = require('../services/visualHotspotService');

const router = express.Router();
const THREAD_RE = /^[A-Za-z0-9_-]{1,80}$/;
const buckets = new Map();

function tenant(req, res) {
  if (req.siteOpenMode) {
    res.status(403).json({ error: '운영 제안 에이전트는 사이트 접근 키 보호가 활성화된 환경에서만 사용할 수 있습니다.' });
    return null;
  }
  const value = canonicalOrigin(req.siteOrigin);
  if (!value) {
    res.status(403).json({ error: '운영 제안 에이전트는 담당 쇼핑몰이 확정된 접근 키로만 사용할 수 있습니다.' });
    return null;
  }
  return value;
}

function rateLimited(tenantId) {
  const now = Date.now();
  const recent = (buckets.get(tenantId) || []).filter((time) => now - time < 60_000);
  if (recent.length >= 10) return true;
  recent.push(now);
  buckets.set(tenantId, recent);
  return false;
}

router.get('/profile', (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  res.json(agentProfile(tenantId));
});

router.get('/captures/:runId/:filename', (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  const target = resolveCapturePath(tenantId, req.params.runId, req.params.filename);
  if (!target) return res.status(404).json({ error: '해당 쇼핑몰의 캡처를 찾지 못했습니다.' });
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(target);
});

router.get('/threads', async (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  try {
    const rows = await AgentThread.find({ tenant_id: tenantId })
      .sort({ updated_at: -1 })
      .limit(20)
      .lean();
    res.json({
      tenant_id: tenantId,
      threads: rows.map((thread) => {
        const firstQuestion = (thread.messages || []).find((message) => message.role === 'user');
        const lastMessage = (thread.messages || []).at(-1);
        return {
          thread_id: thread.thread_id,
          title: String(firstQuestion?.content || '새 운영 대화').slice(0, 42),
          preview: lastMessage?.role === 'assistant'
            ? String(lastMessage.content?.summary || '').slice(0, 72)
            : String(lastMessage?.content || '').slice(0, 72),
          message_count: (thread.messages || []).length,
          saved_action_count: (thread.saved_actions || []).filter((item) => item.status !== 'done').length,
          updated_at: thread.updated_at,
        };
      }),
    });
  } catch (error) {
    console.error('[ops-agent/threads]', error.message);
    res.status(503).json({ error: '운영 제안 대화 목록을 불러오지 못했습니다.' });
  }
});

router.get('/threads/:threadId', async (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  if (!THREAD_RE.test(req.params.threadId)) return res.status(400).json({ error: '대화 ID가 올바르지 않습니다.' });
  try {
    const thread = await AgentThread.findOne({ tenant_id: tenantId, thread_id: req.params.threadId }).lean();
    res.json({
      tenant_id: tenantId,
      thread_id: req.params.threadId,
      messages: (thread?.messages || []).slice(-20),
      snapshot: thread?.snapshot || null,
      saved_actions: thread?.saved_actions || [],
    });
  } catch (error) {
    console.error('[ops-agent/thread]', error.message);
    res.status(503).json({ error: '운영 제안 대화 기록을 불러오지 못했습니다.' });
  }
});

router.post('/threads/:threadId/actions', async (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  if (!THREAD_RE.test(req.params.threadId)) return res.status(400).json({ error: '대화 ID가 올바르지 않습니다.' });
  const actions = (Array.isArray(req.body?.actions) ? req.body.actions : [])
    .map((item) => String(item || '').trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 5);
  if (!actions.length) return res.status(400).json({ error: '저장할 실행안이 없습니다.' });
  try {
    const now = new Date();
    const thread = await AgentThread.findOneAndUpdate(
      { tenant_id: tenantId, thread_id: req.params.threadId },
      {
        $set: { updated_at: now },
        $push: { saved_actions: { $each: actions.map((text) => ({ text, status: 'planned', created_at: now })), $slice: -30 } },
      },
      { new: true },
    ).lean();
    if (!thread) return res.status(404).json({ error: '대화를 찾지 못했습니다.' });
    res.json({ saved_actions: thread.saved_actions || [] });
  } catch (error) {
    console.error('[ops-agent/actions]', error.message);
    res.status(503).json({ error: '실행안을 저장하지 못했습니다.' });
  }
});

router.post('/threads/:threadId/feedback', async (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  if (!THREAD_RE.test(req.params.threadId)) return res.status(400).json({ error: '대화 ID가 올바르지 않습니다.' });
  const requestId = String(req.body?.request_id || '').trim();
  const value = String(req.body?.value || '').trim();
  if (!requestId || !['helpful', 'not_helpful'].includes(value)) return res.status(400).json({ error: '피드백 값이 올바르지 않습니다.' });
  try {
    const result = await AgentThread.updateOne(
      { tenant_id: tenantId, thread_id: req.params.threadId },
      { $set: { 'messages.$[message].feedback': value, updated_at: new Date() } },
      { arrayFilters: [{ 'message.role': 'assistant', 'message.request_id': requestId }] },
    );
    if (!result.matchedCount) return res.status(404).json({ error: '대화를 찾지 못했습니다.' });
    res.json({ ok: true, feedback: value });
  } catch (error) {
    console.error('[ops-agent/feedback]', error.message);
    res.status(503).json({ error: '피드백을 저장하지 못했습니다.' });
  }
});

router.post('/chat', async (req, res) => {
  const tenantId = tenant(req, res);
  if (!tenantId) return;
  if (rateLimited(tenantId)) return res.status(429).json({ error: '질문이 너무 빠르게 이어지고 있습니다. 잠시 후 다시 시도해주세요.' });

  const question = String(req.body?.question || '').trim();
  const threadId = String(req.body?.thread_id || 'operations').trim();
  const requestId = String(req.body?.request_id || '').trim();
  const days = Math.min(Math.max(Number(req.body?.days) || 7, 1), 31);
  if (!question || question.length > 1000) return res.status(400).json({ error: '질문은 1~1000자로 입력해주세요.' });
  if (!THREAD_RE.test(threadId)) return res.status(400).json({ error: '대화 ID가 올바르지 않습니다.' });
  if (requestId && !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) return res.status(400).json({ error: '요청 ID가 올바르지 않습니다.' });

  try {
    const profile = agentProfile(tenantId);
    const existing = await AgentThread.findOne({ tenant_id: tenantId, thread_id: threadId }).lean();
    const history = (existing?.messages || []).slice(-8);
    if (requestId) {
      const duplicate = history.find((message) => message.role === 'assistant' && message.request_id === requestId);
      if (duplicate) {
        return res.json({
          tenant_id: tenantId,
          thread_id: threadId,
          agent: profile,
          answer: duplicate.content,
          used_tools: duplicate.used_tools || [],
          plan: duplicate.query_plan || null,
          snapshot: existing?.snapshot || null,
          source: 'idempotent_replay',
        });
      }
    }
    const result = await answerQuestion({
      origin: tenantId,
      question,
      days,
      history,
      snapshot: existing?.snapshot || null,
    });
    const now = new Date();
    await AgentThread.findOneAndUpdate(
      { tenant_id: tenantId, thread_id: threadId },
      {
        $set: { agent_name: profile.name, updated_at: now, snapshot: result.snapshot },
        $setOnInsert: { created_at: now },
        $push: {
          messages: {
            $each: [
              {
                role: 'user', content: question, request_id: requestId,
                snapshot_id: result.snapshot.id, query_plan: result.plan, created_at: now,
              },
              {
                role: 'assistant', content: result.answer, request_id: requestId,
                snapshot_id: result.snapshot.id, used_tools: result.used_tools,
                query_plan: result.plan, metric_digest: result.snapshot.metric_digest, created_at: now,
              },
            ],
            $slice: -40,
          },
        },
      },
      { upsert: true, new: true },
    );
    res.json({
      tenant_id: tenantId,
      thread_id: threadId,
      request_id: requestId,
      agent: profile,
      ...result,
    });
  } catch (error) {
    console.error('[ops-agent/chat]', error.message);
    if (error.name === 'AgentValidationError') return res.status(400).json({ error: error.message });
    res.status(503).json({ error: '운영 데이터를 분석하는 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

module.exports = router;
