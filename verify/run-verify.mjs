/**
 * run-verify —— flint-console 验证套件汇总器（家族纪律：全绿才算完成）。
 * 运行：node verify/run-verify.mjs（等价 npm run verify）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = ['verify-sse.mjs', 'verify-rpc-driver.mjs'];

let fail = 0;
for (const suite of SUITES) {
  console.log(`\n━━━ ${suite} ━━━`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, suite)], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (code !== 0) fail++;
}

console.log(`\n${'═'.repeat(40)}`);
console.log(fail === 0
  ? `🎉 全套通过（${SUITES.length} 套件全绿）`
  : `💥 ${fail} 个套件挂了`);
process.exit(fail === 0 ? 0 : 1);
