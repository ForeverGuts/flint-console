/**
 * static —— 静态文件服务（web/ 目录）。
 * 调用方：server/main.ts
 * 服务于：原生前端三件套的投递。Node 内置 http + 手写 mime 表，零依赖。
 *
 * 安全：路径穿越防护——resolve 后必须仍落在 web 根目录内，否则 403。
 *      （闸判定永远在服务端，前端不可信——这条纪律从 flint 一路带过来。）
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function serveStatic(webRoot: string, req: IncomingMessage, res: ServerResponse): void {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let filePath = path.normalize(path.join(webRoot, urlPath === '/' ? 'index.html' : urlPath));

  // 路径穿越防护：解析后的真实路径必须仍在 webRoot 内
  if (!filePath.startsWith(path.resolve(webRoot))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // 目录请求补 index.html（防 /web/ 这类目录形态直接列目录）
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime || !existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }
  res.writeHead(200, { 'Content-Type': mime });
  createReadStream(filePath).pipe(res);
}
