/**
 * A tiny static server for the site, so `fetch('data/faucet.json')` works
 * locally without pulling a dependency in just to look at a page.
 *
 *   npm run serve   ->  http://localhost:4173
 */

import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('site');
const PORT = Number(process.env.PORT ?? 4173);

/* Serve with the exact headers vercel.json declares (CSP included), so a
   policy that would break the page in production breaks it here first. */
const VERCEL = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8'));
const HEADER_RULES = (VERCEL.headers ?? []).map((rule) => ({
  test: new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*').replace(/\(([^)]+)\)/g, '($1)')}$`),
  headers: Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value])),
}));

function headersFor(pathname) {
  const out = {};
  for (const rule of HEADER_RULES) if (rule.test.test(pathname)) Object.assign(out, rule.headers);
  return out;
}

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

  let status = 200;
  try {
    let info = await stat(path).catch(() => null);
    // cleanUrls, as on Vercel: /docs serves docs.html.
    if (!info && !extname(path)) { path = `${path}.html`; info = await stat(path); }
    if (!info) throw new Error('missing');
    if (info.isDirectory()) path = join(path, 'index.html');
  } catch {
    // Mirror Vercel: a missing route gets the themed 404 page.
    status = 404;
    path = join(ROOT, '404.html');
  }

  res.writeHead(status, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...headersFor(requested),
  });
  createReadStream(path).pipe(res);
});

server.listen(PORT, () => {
  process.stdout.write(`\n  faucet site  ->  http://localhost:${PORT}\n\n`);
});
