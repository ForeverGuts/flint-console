/**
 * verify-rpc-driver —— rpc-driver 的行为证明（不开浏览器、不调 LLM、零成本）。
 * 断言链：spawn flint → ping 通 → 会话四件套（info/create/list/clear）→ 优雅关停退干净。
 * 运行：node verify/verify-rpc-driver.mjs（FLINT_ROOT 可覆盖 flint 仓库位置）
 */
import { FlintRpcDriver } from '../server/rpc-driver.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unlinkSync } from 'node:fs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLINT_ROOT = process.env.FLINT_ROOT ?? path.resolve(REPO_ROOT, '..', 'Flint');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  ok ? pass++ : fail++;
}

console.log(`[verify] flint 仓库：${FLINT_ROOT}`);
const driver = new FlintRpcDriver(FLINT_ROOT);
const stderrTail = [];
driver.on('stderr', (line) => {
  stderrTail.push(line);
  if (stderrTail.length > 5) stderrTail.shift();
});

const t0 = Date.now();
try {
  // ① ping：spawn + 协议配对的最小证明
  const pong = await driver.request('ping');
  check('ping → pong', pong === 'pong', `启动+往返 ${(Date.now() - t0)}ms`);

  // ② get_session_info：形状契约（model/provider/msgCount 必在）
  const info = await driver.request('get_session_info');
  const infoOk = info && typeof info.model === 'string' && typeof info.provider === 'string'
    && typeof info.msgCount === 'number';
  check('get_session_info 形状', Boolean(infoOk), JSON.stringify(info));

  // ③ create_session：返回文件名
  const name = `verify-console-${Date.now().toString(36)}.jsonl`;
  const created = await driver.request('create_session', { name });
  check('create_session 返回文件名', typeof created === 'string' && created.includes('verify-console'), String(created));

  // ④ list_sessions：能看见刚建的
  const sessions = await driver.request('list_sessions');
  const listOk = Array.isArray(sessions) && JSON.stringify(sessions).includes('verify-console');
  check('list_sessions 含新会话', Boolean(listOk), `共 ${Array.isArray(sessions) ? sessions.length : '?'} 个`);

  // ⑤ clear：清空返回 ok
  const cleared = await driver.request('clear');
  check('clear → ok', cleared === 'ok', String(cleared));
} catch (err) {
  check('RPC 链路', false, err.message);
  if (stderrTail.length) console.error('[flint stderr 尾巴]\n' + stderrTail.join('\n'));
}

// ⑥ 优雅关停：合 stdin 后 flint 自己退（不给 flint 留僵尸进程是 driver 的职责）
await driver.shutdown();
check('优雅关停（stdin EOF → 自然退出）', !driver.alive);

// ⑦ 自产垃圾清理：verify 建的会话文件删掉（flint sessions 目录是用户的地盘，不留烟头）
try {
  unlinkSync(path.join(FLINT_ROOT, 'sessions', String(created)));
  console.log(`🧹 已清理冒烟会话文件 ${created}`);
} catch { /* 清理失败不挡判定 */ }

console.log(`\n${fail === 0 ? '🎉' : '💥'} verify-rpc-driver：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
