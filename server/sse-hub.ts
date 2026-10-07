/**
 * sse-hub —— 事件流 → SSE 推给浏览器（下行通道）。
 * 调用方：server/main.ts（装配时把 rpc-driver 的 update 事件接进来）、verify/verify-sse.mjs
 * 服务于：策划案 D1——下行 SSE + 上行 POST，不上 WebSocket，零依赖。
 *
 * 断线重连语义：每条事件带自增 id，浏览器 EventSource 重连时自动带 Last-Event-ID 头，
 * 这里从环形缓冲回放缺失的部分。缓冲上限 500 条——回放是"重连救急"不是"历史查询"，
 * 真要回放整段会话，那是 M2 之后的事（留白）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** RING_MAX 条以内的回放能力；再早的事件视同"没收到过"（页面重置现状即可） */
const RING_MAX = 500;
/** 心跳间隔：15 秒一条注释行，防代理掐闲连接 */
const HEARTBEAT_MS = 15_000;

interface SseRecord {
  id: number;
  event: string;
  data: string;
}

export class SseHub {
  private clients = new Map<number, ServerResponse>();
  private nextClientId = 1;
  private ring: SseRecord[] = [];
  private nextEventId = 1;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  /** 接入一个 SSE 客户端（连接关闭时自动清走） */
  addClient(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 交给 nginx 时不缓冲（部署留白，v1 本机直连用不到）
    });
    res.write(': connected\n\n');

    const id = this.nextClientId++;
    this.clients.set(id, res);
    req.on('close', () => this.clients.delete(id));

    // Last-Event-ID 回放：只回比它新的（第一轮只留最小可用语义，精化留白）
    const lastId = Number(req.headers['last-event-id'] ?? 0);
    if (Number.isFinite(lastId) && lastId > 0) {
      for (const rec of this.ring) {
        if (rec.id > lastId) this.writeRecord(res, rec);
      }
    }
  }

  /** 广播一条事件（event 名 + 任意可 JSON 化数据）。没有客户端也照记——回放缓冲不依赖在线者。 */
  publish(event: string, data: unknown): void {
    const rec: SseRecord = {
      id: this.nextEventId++,
      event,
      data: JSON.stringify(data),
    };
    this.ring.push(rec);
    if (this.ring.length > RING_MAX) this.ring.shift();
    for (const res of this.clients.values()) {
      this.writeRecord(res, rec);
    }
  }

  /** 在线客户端数（诊断用） */
  get clientCount(): number {
    return this.clients.size;
  }

  startHeartbeat(): void {
    this.heartbeatTimer ??= setInterval(() => {
      for (const res of this.clients.values()) {
        if (!res.writableEnded) res.write(': hb\n\n');
      }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private writeRecord(res: ServerResponse, rec: SseRecord): void {
    if (res.writableEnded) return;
    res.write(`id: ${rec.id}\nevent: ${rec.event}\ndata: ${rec.data}\n\n`);
  }
}
