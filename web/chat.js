/**
 * chat.js —— 聊天流渲染（M1 闭环主体）。
 * 现状（最简版）：SSE chunk 到一条追加一条——**这本身就是流式**，打字机 CSS 动效是 M2 留白。
 * 结构：每轮对话 = 一个 user 气泡 + 一个 assistant 气泡（chunk 往里追加）。
 * 思考流（agent_thought_chunk）走灰色斜体小字，视觉上与正文分开。
 */
export class Chat {
  /** @param {HTMLElement} root #chat-log */
  constructor(root) {
    this.root = root;
    this.bubble = null;      // 当前 assistant 气泡
    this.thought = null;     // 当前思考流块
  }

  /** 用户发送消息：新增 user 气泡，并把"当前 assistant 气泡"指针复位 */
  beginUserTurn(message) {
    this.root.insertAdjacentHTML('beforeend',
      `<div class="msg msg-user">${escapeHtml(message)}</div>`);
    this.bubble = null;
    this.thought = null;
    this.scroll();
  }

  /** 预挂一个空的 assistant 气泡，等 chunk 进来填 */
  beginAssistantTurn() {
    this.root.insertAdjacentHTML('beforeend', `
      <div class="msg msg-assistant">
        <div class="thought hidden"></div>
        <div class="text"></div>
      </div>`);
    this.bubble = this.root.lastElementChild;
    this.thought = this.bubble.querySelector('.thought');
    this.scroll();
  }

  /** agent_message_chunk：往当前气泡追加正文 */
  appendChunk(text) {
    if (!this.bubble) this.beginAssistantTurn();
    this.bubble.querySelector('.text').append(text);
    this.scroll();
  }

  /** agent_thought_chunk：灰色思考流（有多条就换行续写） */
  appendThought(text) {
    if (!this.bubble) this.beginAssistantTurn();
    this.thought.classList.remove('hidden');
    this.thought.append((this.thought.textContent ? '\n' : '') + text);
    this.scroll();
  }

  /** 一轮正常结束：清掉思考流的临时感（保留内容，降透明度） */
  finishTurn() {
    if (this.thought) this.thought.classList.add('settled');
    this.scroll();
  }

  /** POST 失败 / 网络断：红色错误条（气泡内） */
  showError(message) {
    if (!this.bubble) this.beginAssistantTurn();
    this.bubble.querySelector('.text').insertAdjacentHTML('beforeend',
      `<div class="error-line">⚠ ${escapeHtml(message)}</div>`);
    this.scroll();
  }

  clear() {
    this.root.innerHTML = '';
    this.bubble = null;
    this.thought = null;
  }

  scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
