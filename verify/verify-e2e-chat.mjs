/**
 * verify-e2e-chat —— 端到端真对话（**显式花一次最小 LLM 调用**，不进默认套件）。
 * 断言链：起服务 → 建 e2e 专属会话（不污染用户历史）→ SSE 挂收流器
 *        → POST /api/chat 问 1+1 → SSE 收到流式 chunk + 最终回复落定 → 优雅收摊。
 * 运行：node verify/verify-e2e-chat.mjs
 */
import { createApp } from '../server/main.ts';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLINT_ROOT = process.env.FLINT_ROOT ?? path.resolve(REPO_ROOT, '..', 'Flint');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

const app = createApp({ flintRoot: FLINT_ROOT });
await new Promise((resolve) => app.server.listen(0, resolve));
const port = app.server.address().port;
console.log(`[e2e] 服务端口 ${port}，flint 在 ${FLINT_ROOT}`);

// 建 e2e 专属会话：冒烟残留与用户真实历史隔离
const sessionFile = await app.driver.request('create_session', { name: `e2e-console-${Date.now().toString(36)}.jsonl` });
console.log(`[e2e] 会话：${sessionFile}`);

// SSE 收流器：记下所有 update 判别式 + 正文累计
/** @type {{kinds: string[], chunks: string[], thoughts: string[], notices: string[]}} */
const seen = { kinds: [], chunks: [], thoughts: [], notices: [] };
const conn = await new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => resolve(res));
  req.on('error', reject);
});
let buf = '';
conn.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
    const dm = frame.match(/^data: (.+)$/m);
    if (!dm || !frame.includes('event: session/update')) continue;
    try {
      const { update } = JSON.parse(dm[1]);
      seen.kinds.push(update.sessionUpdate);
      if (update.sessionUpdate === 'agent_message_chunk') seen.chunks.push(update.content?.text ?? '');
      if (update.sessionUpdate === 'agent_thought_chunk') seen.thoughts.push(update.content?.text ?? '');
      if (update.sessionUpdate === 'notice') seen.notices.push(`${update.severity}:${update.title}`);
    } catch { /* 忽略半帧 */ }
  }
});

const t0 = Date.now();
try {
  // 真对话：一次最小问答
  const resp = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '1+1等于几？直接回答，不要调用任何工具。' }),
  });
  const body = await resp.json();
  check('POST /api/chat 200 且有 reply', resp.ok && typeof body.reply === 'string' && body.reply.length > 0,
    `HTTP ${resp.status}，${String(body.reply).slice(0, 60)}`);
  check('最终回复答出 2', /2/.test(String(body.reply)), String(body.reply).slice(0, 40));

  // 给 SSE 尾巴一点时间（最终响应与最后 chunk 的竞态）
  await new Promise((r) => setTimeout(r, 800));
  check('SSE 收到流式正文 chunk', seen.chunks.length > 0, `${seen.chunks.length} 片，合计 ${seen.chunks.join('').length} 字`);
  check('SSE 收到 thinking 阶段通知（info）', seen.notices.some((n) => n.startsWith('info:')),
    seen.notices.slice(0, 3).join(' / '));
  check('事件判别式全部合法',
    seen.kinds.every((k) => ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'notice'].includes(k)),
    [...new Set(seen.kinds)].join(', '));

  console.log(`[e2e] 全程 ${(Date.now() - t0) / 1000}s；事件序列：${seen.kinds.join(' → ') || '（无）'}`);
} catch (err) {
  check('端到端对话', false, err.message);
}

// 清理：e2e 专属会话文件（本次冒烟的自产垃圾，删自己造的）
conn.destroy();
await app.close();
try {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(path.join(FLINT_ROOT, 'sessions', String(sessionFile)));
  console.log(`[e2e] 已清理冒烟会话文件 ${sessionFile}`);
} catch { /* 清理失败不挡判定 */ }

console.log(`\n${fail === 0 ? '🎉' : '💥'} verify-e2e-chat：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
