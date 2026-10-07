/**
 * gate.js —— 安全闸面板（v0 展示桩，刻意不写深）。
 *
 * 现状能做的只有一件事：把 notice 事件（flint 的 thinking 阶段与 error/warning）
 * 显示出来——error=红卡、warning=黄卡、info=顶部状态行。
 *
 * 刻意留白（= docs/待拷问清单.md 的主菜，动 flint 前不动这里）：
 *   - 确认按钮流：RPC 模式下 flint 权限自动放行，按钮流是无源之水（缺口①，Q1）
 *   - 拦截审计列表：同样依赖 flint 侧有拦截事件出口
 *   - 红色脉冲动画：等真卡有了再打磨（有数据才有动效）
 */
export class Gate {
  /** @param {HTMLElement} root #gate */
  constructor(root) {
    this.root = root;
    this.statusLine = null;
  }

  /** notice：severity error/warning → 追加卡片；info → 替换式状态行（thinking 阶段不刷屏） */
  notice(update) {
    this.empty()?.remove();
    if (update.severity === 'info') {
      this.setStatus(update.title ?? '');
      return;
    }
    const sev = update.severity === 'error' ? 'gate-error' : 'gate-warn';
    this.root.insertAdjacentHTML('beforeend', `
      <div class="gate-card ${sev}">
        <span class="gate-sev">${update.severity === 'error' ? '⛔' : '⚠'}</span>
        <span class="gate-msg">${escapeHtml(update.title ?? '')}</span>
      </div>`);
    this.scroll();
  }

  /** 替换式状态行："正在分析输入"→"正在等待模型响应" 只保留最新一条 */
  setStatus(text) {
    if (!this.statusLine) {
      this.root.insertAdjacentHTML('afterbegin', '<div class="gate-status"></div>');
      this.statusLine = this.root.querySelector('.gate-status');
    }
    this.statusLine.textContent = `… ${text}`;
  }

  clear() {
    this.root.innerHTML = '<p class="muted small" id="gate-empty">（暂无错误/警告事件）</p>';
    this.statusLine = null;
  }

  empty() {
    return this.root.querySelector('#gate-empty');
  }

  scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
