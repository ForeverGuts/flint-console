/**
 * timeline.js —— 工具调用时间线（v0 最简版）。
 * 现状：tool_call 建节点（spinner），tool_call_update 靠 toolCallId 配对定格 ✓/✗。
 *      RAG 检索（工具名 note_search）打上专属标——它就是"翻笔记中"节点的雏形。
 *
 * 留白（M2 再做，刻意不写深）：
 *   - 耗时显示（需要 flint 外发 span 事件，见 docs/事件映射表.md 缺口② / 待拷问清单 Q2）
 *   - 参数摘要（rawInput 的 path/grep 关键字等）
 *   - 结果展开/折叠（rawOutput 现在只截 120 字）
 *   - RAG 节点专属动画（"翻笔记中"）
 *   - 按 turnId 分轮分组（v0 一轮清一次）
 */
const SUMMARY_MAX = 120;

export class Timeline {
  /** @param {HTMLElement} root #timeline */
  constructor(root) {
    this.root = root;
    this.nodes = new Map(); // toolCallId -> 节点元素
  }

  /** 新一轮对话开始：清空上一轮的节点（v0 口径：只看当下这轮） */
  beginRound() {
    this.clear();
  }

  /** tool_call：新建节点 */
  start(update) {
    this.empty()?.remove();
    const isRag = update.title === 'note_search';
    this.root.insertAdjacentHTML('beforeend', `
      <div class="tl-node" data-id="${update.toolCallId}">
        <span class="tl-spinner" aria-hidden="true"></span>
        <span class="tl-title">${escapeHtml(update.title)}</span>
        ${isRag ? '<span class="tl-tag">RAG</span>' : ''}
        <span class="tl-kind">${escapeHtml(update.kind ?? 'other')}</span>
      </div>`);
    this.nodes.set(update.toolCallId, this.root.lastElementChild);
    this.scroll();
  }

  /** tool_call_update：配对定格 */
  end(update) {
    const node = this.nodes.get(update.toolCallId);
    if (!node) return; // 断线重连丢了 start 事件：宁可少一条也不画错位（回放精化 = 留白）
    node.querySelector('.tl-spinner')?.remove();
    const ok = update.status === 'completed';
    node.classList.add(ok ? 'tl-ok' : 'tl-fail');
    node.insertAdjacentHTML('beforeend',
      `<span class="tl-status">${ok ? '✓' : '✗'}</span>`);
    const summary = String(extractOutput(update.rawOutput));
    if (summary) {
      node.insertAdjacentHTML('beforeend',
        `<div class="tl-output">${escapeHtml(summary.slice(0, SUMMARY_MAX))}${summary.length > SUMMARY_MAX ? '…' : ''}</div>`);
    }
    this.scroll();
  }

  clear() {
    this.root.innerHTML = '<p class="muted small" id="timeline-empty">（本轮还没有工具调用）</p>';
    this.nodes.clear();
  }

  empty() {
    return this.root.querySelector('#timeline-empty');
  }

  scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

/** rawOutput 形状：{output: string}（映射层 stringifyResult 包过） */
function extractOutput(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw.output === 'string') return raw.output;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
