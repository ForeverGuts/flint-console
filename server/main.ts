/**
 * main —— flint-console 装配层。
 * 调用方：node server/main.ts（直接运行）、verify/verify-sse.mjs（import createApp 起测试服务）
 * 服务于：把 rpc-driver（flint 子进程）、sse-hub（下行）、static（页面）组装成一个零依赖 http 服务。
 *
 * 路由（上行就四个，够 v1；多会话/分叉等留白给拷问后再说）：
 *   GET  /api/events   SSE 下行（session/update 原样转发，信封不改——"同一核心两张脸"）
 *   POST /api/chat     {message, maxTurns?} → flint chat，响应 = 最终回复
 *   POST /api/clear    清空当前 flint 会话
 *   GET  /api/session  当前会话信息 + 会话列表
 *   其余路径 → web/ 静态文件
 *
 * 事件透传策略（策划案 D3 的 v1 口径）：flint 的 session/update **原样转发**，
 * console 不重定义事件形状——console 只是第二个订阅者，不是新协议的发起人。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FlintRpcDriver, type RpcError } from './rpc-driver.ts';
import { SseHub } from './sse-hub.ts';
import { serveStatic } from './static.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface App {
  server: Server;
  driver: FlintRpcDriver;
  hub: SseHub;
  close(): Promise<void>;
}

/** 读 JSON 请求体（上限 1MB——聊天消息没有理由更大） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体超过 1MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createApp(opts?: { flintRoot?: string; webRoot?: string }): App {
  const flintRoot = opts?.flintRoot
    ?? process.env.FLINT_ROOT
    ?? path.resolve(REPO_ROOT, '..', 'Flint'); // 部署约定：与 flint 仓库并排放
  const webRoot = opts?.webRoot ?? path.join(REPO_ROOT, 'web');

  const driver = new FlintRpcDriver(flintRoot);
  const hub = new SseHub();

  // flint 事件 → SSE 原样转发（信封 params 不动）
  driver.on('update', (n) => hub.publish('session/update', n.params));
  // flint 的 stderr 日志 → 本进程 stderr（排查用，不加温）
  driver.on('stderr', (line) => console.error('[flint]', line));

  const server = createServer(async (req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && urlPath === '/api/events') {
        hub.addClient(req, res);
        return;
      }

      if (req.method === 'POST' && urlPath === '/api/chat') {
        let message = '';
        let maxTurns: number | undefined;
        try {
          const body = JSON.parse(await readBody(req)) as { message?: unknown; maxTurns?: unknown };
          if (typeof body.message !== 'string' || body.message.length === 0) {
            return json(res, 400, { error: 'message 必须是非空字符串' });
          }
          message = body.message;
          if (body.maxTurns !== undefined) {
            if (typeof body.maxTurns !== 'number' || !Number.isInteger(body.maxTurns) || body.maxTurns < 1) {
              return json(res, 400, { error: 'maxTurns 必须是正整数' });
            }
            maxTurns = body.maxTurns;
          }
        } catch {
          return json(res, 400, { error: '请求体必须是合法 JSON' });
        }
        try {
          const reply = await driver.chat(message, maxTurns);
          return json(res, 200, { reply });
        } catch (err) {
          const e = err as Error & { code?: number };
          if (e.code === -32000) {
            // CHAT_BUSY：flint 本版不支持并发 chat。多页签语义是留白（待拷问清单 Q4）。
            return json(res, 409, { error: '已有对话在进行中（本版不支持并发）——等上一轮结束再发' });
          }
          return json(res, 502, { error: `flint 调用失败：${e.message}` });
        }
      }

      if (req.method === 'POST' && urlPath === '/api/clear') {
        await driver.request('clear');
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && urlPath === '/api/session') {
        const [info, sessions] = await Promise.all([
          driver.request('get_session_info'),
          driver.request('list_sessions'),
        ]);
        return json(res, 200, { info, sessions });
      }

      if (urlPath.startsWith('/api/')) {
        return json(res, 404, { error: `未知 API：${req.method} ${urlPath}` });
      }

      serveStatic(webRoot, req, res);
    } catch (err) {
      // 兜底：任何一路漏掉的异常都别把进程带走；响应已开头就只剩断开
      const e = err as RpcError & Error;
      if (res.headersSent) { res.destroy(); return; }
      json(res, 500, { error: e.message });
    }
  });

  hub.startHeartbeat();

  return {
    server,
    driver,
    hub,
    async close() {
      hub.stopHeartbeat();
      await driver.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/* ── 直接运行：node server/main.ts ─────────────────────────── */
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const PORT = Number(process.env.PORT ?? 3210);
  const app = createApp();

  app.server.listen(PORT, () => {
    console.log(`[flint-console] http://localhost:${PORT}  （flint 仓库：${app.driver.flintRoot}）`);
    console.log('[flint-console] 刻意留白处见 README「留白清单」与 docs/待拷问清单.md');
  });

  // Ctrl+C：优雅关停（合 stdin 让 flint 跑完退出钩子，再收摊）
  process.on('SIGINT', () => {
    console.log('\n[flint-console] 优雅关停中…');
    void app.close().then(() => process.exit(0));
  });
}
