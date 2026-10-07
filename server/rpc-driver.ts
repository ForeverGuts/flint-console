/**
 * rpc-driver —— 把 flint（RPC 模式）拉起来当子进程，把它的 JSON-RPC 流翻译成本进程可消费的事件。
 * 调用方：server/main.ts（装配）、verify/verify-rpc-driver.mjs（直接驱动）
 * 服务于：flint-console 与 flint 的唯一通信通道。本文件**不 import 任何 flint 源码**——
 *        通信边界 = RPC 协议 = 契约（策划案 D0：零拷贝 + RPC 驱动）。
 *
 * 三条规矩：
 *   ① 懒启动自愈：子进程死了不自动重启、不后台轮询——下一次请求进来时 ensureAlive() 再拉起。
 *      没有"永远在线的看门狗"，就没有"看门狗自己死了谁看着"的问题。
 *   ② 超时判死：请求超时不只是拒绝——把子进程一起终止（挂在 LLM 网络上的 chat 没有第二个出路）。
 *   ③ 优雅关停优先：先合 stdin（flint 的 RPC 主循环读到 EOF 自然退出，退出钩子含 MCP 子进程清理能跑完），
 *      等 3 秒仍不退才强杀——Windows 下强杀 = TerminateProcess，flint 没机会跑退出钩子。
 *
 * 协议（对齐 flint src/harness/rpc.ts，侦察记录见 docs/事件映射表.md）：
 *   每行一个 JSON。请求 {jsonrpc,id,method,params} → 响应 {jsonrpc,id,result|error}；
 *   chat 期间另推 session/update 通知（无 id）：{jsonrpc,method,params:{sessionId,update}}。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** session/update 通知（flint → 外部，无 id，chat 期间流动） */
export interface SessionUpdateNotification {
  jsonrpc: '2.0';
  method: 'session/update';
  params: { sessionId: string; update: Record<string, unknown> };
}

/** JSON-RPC 错误对象（flint 错误码原样透传，语义见 docs/事件映射表.md 第一节） */
export interface RpcError {
  code: number;
  message: string;
}

export class FlintRpcDriver extends EventEmitter {
  private child: ChildProcess | null = null;
  private pending = new Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (err: Error & { code?: number }) => void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 1;
  /** flint 仓库根目录（含 node_modules/tsx 与 src/index.ts）。默认取隔壁 `../Flint`，可用环境变量覆盖。 */
  readonly flintRoot: string;

  constructor(flintRoot: string) {
    super();
    this.flintRoot = flintRoot;
  }

  /* ── 子进程生命周期 ─────────────────────────────────────────── */

  /** 子进程是否活着（spawn 过且未退出） */
  get alive(): boolean {
    return this.child != null && this.child.exitCode == null && this.child.killed === false;
  }

  /** 懒启动：活着就复用，死了（或从没起过）就拉起。所有请求的必经之路。 */
  private ensureAlive(): ChildProcess {
    if (this.alive) return this.child!;
    if (this.child) this.detachChild(this.child); // 上一具尸体的监听还没卸干净
    return this.spawnChild();
  }

  private spawnChild(): ChildProcess {
    const tsxCli = path.join(this.flintRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const entryTs = path.join(this.flintRoot, 'src', 'index.ts');
    const child = spawn(process.execPath, [tsxCli, entryTs], {
      cwd: this.flintRoot,
      env: { ...process.env, FLINT_MODE: 'rpc' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    // stdout = 协议通道：一行一个 JSON。响应按 id 配对，通知按 method 分发，其余行忽略。
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // 协议纪律下不该发生（flint 有 verify 守 stdout 纯净），防御性忽略
      }
      if (msg.method === 'session/update' && msg.id === undefined) {
        this.emit('update', msg as unknown as SessionUpdateNotification);
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id as number);
        if (!p) return;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        const err = (msg as { error?: RpcError }).error;
        if (err) {
          const e = new Error(err.message) as Error & { code?: number };
          e.code = err.code;
          p.reject(e);
        } else {
          p.resolve((msg as { result: unknown }).result);
        }
      }
    });

    // stderr = flint 的日志通道（协议纪律：flint 只往 stderr 写日志）。逐行转发，加前缀。
    const rlErr = createInterface({ input: child.stderr!, crlfDelay: Infinity });
    rlErr.on('line', (line) => this.emit('stderr', line));

    // 退出：孤儿请求全部落葬，尸体置空（下次 ensureAlive 重新拉起 = 自愈）
    child.once('exit', (code) => {
      this.emit('exit', code);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`flint 子进程退出（code=${code}），请求未完成`));
      }
      this.pending.clear();
      this.detachChild(child);
      if (this.child === child) this.child = null;
    });

    // spawn 本身失败（tsx 路径不存在等）：转成所有在途请求的失败
    child.once('error', (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`flint 子进程启动失败：${err.message}`));
      }
      this.pending.clear();
    });

    return child;
  }

  /** 卸掉尸体上的监听（exit/error 回调里已经清理过一次，这里兜 readline 等残留） */
  private detachChild(child: ChildProcess): void {
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
  }

  /* ── 请求 ──────────────────────────────────────────────────── */

  /**
   * 发一个 JSON-RPC 请求并等响应。
   * @param timeoutMs 超时判死线。chat 默认 10 分钟（LLM + 多轮工具），其余默认 60 秒。
   *   超时 = 拒绝请求 + 终止子进程（规矩②）——挂在网络上的 chat 等不来第二春。
   */
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const child = this.ensureAlive();
    const id = this.nextId++;
    const limit = timeoutMs ?? (method === 'chat' ? 600_000 : 60_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`flint RPC 超时判死（${method}，${limit}ms），子进程已终止`));
        child.kill(); // 规矩②：判死不只拒绝，连进程一起送走
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n';
      child.stdin!.write(line);
    });
  }

  /** 便捷方法：一轮对话。返回最终回复字符串。 */
  chat(message: string, maxTurns?: number): Promise<unknown> {
    return this.request('chat', maxTurns === undefined ? { message } : { message, maxTurns });
  }

  /* ── 关停 ──────────────────────────────────────────────────── */

  /**
   * 优雅关停（规矩③）：合 stdin → flint 读到 EOF 自己退 → 3 秒不退才强杀。
   * 返回时保证进程已结束（或已被强杀）。
   */
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode == null) child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}
