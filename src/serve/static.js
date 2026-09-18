import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.map', '.webmanifest', '.txt', '.xml', '.svg', '.wasm']);

// Serves a build directory the way a CDN would for the purposes of an audit:
// correct content types — a module script served as anything but JavaScript is
// refused — and gzip on text. Without compression the page would be measured
// heavier than it ships, and a baseline could fail on transfer size alone.
//
// Loopback only, on a port the system picks, for as long as one audit needs it:
// two directories served side by side never compete for a port.
export async function serveDirectory(dir) {
  const root = resolve(dir);
  const gzipped = new Map();

  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://kanso').pathname);
      let file = normalize(join(root, pathname));
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (pathname.endsWith('/')) file = join(file, 'index.html');

      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }

      const ext = extname(file).toLowerCase();
      const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream' };
      let body = await readFile(file);

      if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
        if (!gzipped.has(file)) gzipped.set(file, gzipSync(body));
        body = gzipped.get(file);
        headers['content-encoding'] = 'gzip';
        headers.vary = 'accept-encoding';
      }

      res.writeHead(200, headers).end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}
