/**
 * verify-sse —— SSE 下行 + 路由契约的行为证明（不起 flint 子进程，纯本进程，零成本）。
 * 断言链：SSE 响应头 → publish→客户端收到（含 id/event/data 三件套）
 *        → 静态首页 → POST /api/chat 参数校验（400 不触 flint）→ 未知 API 404 → Last-Event-ID 回放。
 * 运行：node verify/verify-sse.mjs
 *
 * ⚠ SSE 流永不 end：所有 SSE 断言都"收到首个数据块就判定"，绝不等流结束。
 */
import { createApp } from '../server/main.ts';
import http from 'node:http';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

/** SSE 连接：响应头一到就 resolve（流继续保持，由调用方 req.destroy 收尾） */
function sseConnect(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, res });
      // 注意：不 end，连接保持；调用方在断言完后 destroy
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('SSE 连接超时')); });
  });
}

/** 普通请求：等到响应结束（静态文件/JSON API 会正常 end） */
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method,
        headers: body !== undefined
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
          : headers },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const app = createApp({ flintRoot: '____nonexistent____' }); // 本测试绝不触发 spawn（没有会碰 driver 的用例）
await new Promise((resolve) => app.server.listen(0, resolve));
const port = app.server.address().port;
console.log(`[verify] 测试服务端口：${port}`);

let clientA = null;
try {
  // ① SSE 响应头（连接 A：保持到测试结束）
  clientA = await sseConnect(port);
  check('SSE 响应头 text/event-stream',
    clientA.status === 200 && String(clientA.headers['content-type']).includes('text/event-stream'),
    String(clientA.headers['content-type']));

  // ② 连接 B：publish → 收到（id/event/data 三件套 + JSON 可解析），然后断开 B
  clientA.res.destroy(); // A 只用来验头，换成 B 做收流断言
  const connB = await sseConnect(port);
  await new Promise((r) => setTimeout(r, 300));
  app.hub.publish('test/hello', { hello: 'world', n: 42 });

  const firstEvent = await new Promise((resolve) => {
    let buf = '';
    connB.res.on('data', (c) => {
      buf += c;
      const m = buf.match(/id: (\d+)\nevent: ([^\n]+)\ndata: (.+)\n\n/s);
      if (m) resolve({ id: Number(m[1]), event: m[2], data: m[3] });
    });
    connB.res.on('close', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
  check('publish → SSE 收到三件套', firstEvent?.event === 'test/hello'
    && firstEvent?.id > 0
    && JSON.parse(firstEvent.data).hello === 'world',
    firstEvent ? `id=${firstEvent.id}` : '没收到');
  connB.res.destroy();

  // ③ 静态首页
  const home = await request(port, 'GET', '/');
  check('静态首页 200 且含 flint-console',
    home.status === 200 && home.body.includes('flint-console'), String(home.status));

  // ④ POST /api/chat 空消息 → 400（不触 flint：driver 从未 spawn）
  const badChat = await request(port, 'POST', '/api/chat', '{}');
  check('chat 空消息 → 400', badChat.status === 400 && badChat.body.includes('message'), badChat.body);

  // ⑤ POST /api/chat 坏 JSON → 400
  const badJson = await request(port, 'POST', '/api/chat', '{not-json');
  check('chat 坏 JSON → 400', badJson.status === 400, badJson.body);

  // ⑥ 未知 API → 404
  const unknown = await request(port, 'GET', '/api/unknown');
  check('未知 API → 404', unknown.status === 404, String(unknown.status));

  // ⑦ Last-Event-ID 回放：只补缺失的事件（test/second 新于 hello）
  app.hub.publish('test/second', { seq: 2 });
  const lastId = firstEvent ? firstEvent.id : 0;
  const connC = await sseConnect(port, { 'Last-Event-ID': String(lastId) });
  const cBody = await new Promise((resolve) => {
    let buf = '';
    connC.res.on('data', (c) => { buf += c; setTimeout(() => resolve(buf), 400); });
    connC.res.on('close', () => resolve(buf));
    setTimeout(() => resolve(buf), 2000);
  });
  connC.res.destroy();
  check('Last-Event-ID 只回放缺失事件',
    cBody.includes('test/second') && !cBody.includes('test/hello'));
} catch (err) {
  check('SSE/路由链路', false, err.message);
}

await app.close();
console.log(`\n${fail === 0 ? '🎉' : '💥'} verify-sse：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
