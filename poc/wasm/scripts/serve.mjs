// Minimal static file server for dist/ (no transparent compression).
// usage: node serve.mjs [dir] [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.gz': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

export function serve(dir, port = 8080) {
  dir = resolve(dir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = normalize(join(dir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!path.startsWith(dir)) { res.writeHead(403).end(); return; }
    try {
      const st = await stat(path);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      res.end(await readFile(path));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir = 'dist', port = '8080'] = process.argv.slice(2);
  await serve(dir, Number(port));
  console.log(`serving ${resolve(dir)} at http://127.0.0.1:${port}/`);
}
