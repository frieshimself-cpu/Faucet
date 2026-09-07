/**
 * A tiny static server for the site, so `fetch('data/faucet.json')` works
 * locally without pulling a dependency in just to look at a page.
 *
 *   npm run serve   ->  http://localhost:4173
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('site');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const requested = decodeURIComponent(url.pathname);
  // normalize() collapses ../ before the join, so a path can't escape ROOT.
  const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let path = join(ROOT, relative === '/' ? 'index.html' : relative);

  if (!path.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
});

server.listen(PORT, () => {
  process.stdout.write(`\n  faucet site  ->  http://localhost:${PORT}\n\n`);
});
