/**
 * app.js —— SSE 收流 + 事件分发（前端装配层）。
 * 职责只有三件：
 *   ① 建一条 EventSource 到 /api/events，把 session/update 里的 update 按判别式分发出去；
 *   ② 把表单提交接到 POST /api/chat（上行就这一个入口）；
 *   ③ 会话信息与清空按钮。
 * 渲染细节全部下放 chat.js / timeline.js / gate.js——"分发者不画图"。
 *
 * 断线重连：EventSource 自带重连 + Last-Event-ID，服务端（sse-hub）负责回放，这里不用写任何重连代码。
 */
import { Chat } from './chat.js';
import { Timeline } from './timeline.js';
import { Gate } from './gate.js';

const chat = new Chat(document.getElementById('chat-log'));
const timeline = new Timeline(document.getElementById('timeline'));
const gate = new Gate(document.getElementById('gate'));

/* ── 下行：SSE ─────────────────────────────────────────────── */
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');

const es = new EventSource('/api/events');
es.onopen = () => {
  connDot.className = 'dot dot-on';
  connText.textContent = '已连接';
};
es.onerror = () => {
  // EventSource 会自己重连（带 Last-Event-ID），这里只改状态灯
  connDot.className = 'dot dot-off';
  connText.textContent = '连接断开，重连中…';
};

es.addEventListener('session/update', (e) => {
  const params = JSON.parse(e.data); // {sessionId, update}
  dispatch(params.update);
});

function dispatch(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':  chat.appendChunk(update.content?.text ?? ''); break;
    case 'agent_thought_chunk':  chat.appendThought(update.content?.text ?? ''); break;
    case 'tool_call':            timeline.start(update); break;
    case 'tool_call_update':     timeline.end(update); break;
    case 'notice':               gate.notice(update); break;
    default: break; // 未知 update 类型：静默忽略（契约向前兼容的留法）
  }
}

/* ── 上行：POST /api/chat ──────────────────────────────────── */
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;

  input.value = '';
  btnSend.disabled = true;
  btnSend.textContent = 'flint 思考中…';
  chat.beginUserTurn(message);
  chat.beginAssistantTurn();
  timeline.beginRound();

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      chat.showError(body.error ?? `请求失败（HTTP ${resp.status}）`);
    } else {
      chat.finishTurn(); // 正文由 SSE chunk 逐片到达，这里只负责收尾状态
    }
  } catch (err) {
    chat.showError(`无法连接本机服务：${err.message}`);
  } finally {
    btnSend.disabled = false;
    btnSend.textContent = '发送';
    input.focus();
  }
});

/* ── 会话信息 / 清空 ───────────────────────────────────────── */
const sessionInfo = document.getElementById('session-info');

async function loadSessionInfo() {
  try {
    const resp = await fetch('/api/session');
    if (!resp.ok) return;
    const { info } = await resp.json();
    sessionInfo.textContent = `${info.provider} · ${info.model} · ${info.msgCount} 条历史`;
  } catch {
    sessionInfo.textContent = '会话信息不可用（flint 未就绪？）';
  }
}
loadSessionInfo();

document.getElementById('btn-clear').addEventListener('click', async () => {
  await fetch('/api/clear', { method: 'POST' });
  chat.clear();
  timeline.clear();
  gate.clear();
  loadSessionInfo();
});
