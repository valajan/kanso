import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { InvalidTarget } from '../../core/target.js';
import { openSite, ServeError, siteFromArgument, siteFromConfig, withSites } from '../index.js';
import { startCommand } from '../command.js';
import { serveDirectory } from '../static.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'kanso-serve-'));
}

// A build directory, as a bundler would leave it.
function build(files = { 'index.html': '<!doctype html><title>t</title><p>hello</p>' }) {
  const dir = tempDir();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

async function answers(url) {
  try {
    const res = await fetch(url);
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// A port nothing listens on, for a command to take.
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

// A project whose "preview server" is a few lines of Node — and one whose
// server is a grandchild, the way `npm run preview` starts one.
function project() {
  const dir = tempDir();
  writeFileSync(join(dir, 'server.cjs'), `
    const http = require('node:http');
    http.createServer((req, res) => res.end('served')).listen(Number(process.argv[2]), '127.0.0.1');
  `);
  writeFileSync(join(dir, 'parent.cjs'), `
    require('node:child_process').spawn(process.execPath, [__dirname + '/server.cjs', process.argv[2]], { stdio: 'inherit' });
    setInterval(() => {}, 1000);
  `);
  writeFileSync(join(dir, 'crash.cjs'), `console.error('Error: Cannot find module vite'); process.exit(3);`);
  writeFileSync(join(dir, 'idle.cjs'), `setInterval(() => {}, 1000);`);
  return dir;
}

const node = (script, ...args) => [JSON.stringify(process.execPath), script, ...args].join(' ');

// --- a directory ------------------------------------------------------------

test('a directory is served with its content types, gzipped where a CDN would', async () => {
  const dir = build({
    'index.html': '<p>home</p>',
    'assets/app.mjs': 'export default 1',
    'assets/logo.png': 'png',
  });
  const server = await serveDirectory(dir);
  try {
    const home = await fetch(server.url);
    assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await home.text(), '<p>home</p>');

    // A module script served as anything but JavaScript is refused by Chrome.
    const script = await rawGet(server.url + 'assets/app.mjs', { 'accept-encoding': 'gzip' });
    assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(script.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(script.body).toString(), 'export default 1');

    const image = await rawGet(server.url + 'assets/logo.png', { 'accept-encoding': 'gzip' });
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.headers['content-encoding'], undefined);

    assert.equal((await fetch(server.url + 'missing.js')).status, 404);
  } finally {
    await server.close();
  }
  assert.equal(await answers(server.url), false, 'closed means closed');
});

test('nothing outside the directory is served', async () => {
  const outside = build({ 'secret.txt': 'no', 'site/index.html': '<p>home</p>' });
  const server = await serveDirectory(join(outside, 'site'));
  try {
    // fetch() would normalise the path away; a raw request does not.
    const res = await rawGet(server.url + '..%2fsecret.txt');
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});

// --- naming a page ----------------------------------------------------------

test('a page named on the command line is a URL or a directory', () => {
  const cwd = build();
  mkdirSync(join(cwd, 'dist'));

  assert.deepEqual(siteFromArgument('http://localhost:4173', 'target', cwd), { url: 'http://localhost:4173/' });
  assert.deepEqual(siteFromArgument('dist', 'target', cwd), { dir: join(cwd, 'dist'), name: 'dist' });
  assert.throws(() => siteFromArgument('nope', 'target', cwd), (err) => err instanceof InvalidTarget && /target is neither a URL nor a directory: nope/.test(err.message));
  assert.throws(() => siteFromArgument('ftp://example.com', 'baseline', cwd), /baseline must be http or https/);
});

test('the serve: block resolves against the file that says it', () => {
  const root = tempDir();
  const configDir = join(root, 'apps', 'web');

  assert.equal(siteFromConfig(undefined, { configDir, cwd: root }), null);
  assert.deepEqual(siteFromConfig({ dir: 'dist' }, { configDir, cwd: root }), { dir: join(configDir, 'dist'), name: join('apps', 'web', 'dist') });
  assert.deepEqual(
    siteFromConfig({ command: 'npm run preview', url: 'http://localhost:4173' }, { configDir, cwd: root }),
    { command: 'npm run preview', url: 'http://localhost:4173/', cwd: configDir },
  );
});

test('a serve: block that says too much, too little, or the wrong thing is refused', () => {
  const where = { configDir: '/p', cwd: '/p' };
  const cases = [
    ['dist', /serve: needs either dir .* or command and url/],
    [{}, /serve: needs either dir/],
    [{ dir: 'dist', command: 'npm start', url: 'http://localhost:3000' }, /takes dir, or command and url — not both/],
    [{ command: 'npm start' }, /serve.command needs serve.url/],
    [{ url: 'http://localhost:3000' }, /serve.url needs serve.command/],
    [{ command: 'npm start', url: 'localhost:3000' }, /serve.url must be http or https/],
    [{ dir: 3 }, /serve.dir must be a path/],
  ];
  for (const [serve, expected] of cases) {
    assert.throws(() => siteFromConfig(serve, where), (err) => err instanceof ServeError && expected.test(err.message), JSON.stringify(serve));
  }
});

test('a directory with nothing built in it is not served', async () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, 'empty'));

  await assert.rejects(openSite({ dir: join(cwd, 'dist'), name: 'dist' }), /there is no dist directory to serve — build the project first/);
  await assert.rejects(openSite({ dir: join(cwd, 'empty'), name: 'empty' }), /empty has no index.html/);
});

test('the page and its baseline are served side by side, and stopped after', async () => {
  const page = build({ 'index.html': 'page' });
  const baseline = build({ 'index.html': 'baseline' });
  let seen;

  const result = await withSites({ page: { dir: page, name: 'dist' }, baseline: { url: 'https://example.com/' } }, async (sites) => {
    seen = sites;
    return (await fetch(sites.url)).text();
  });
  assert.equal(result, 'page');
  assert.equal(seen.baseline, 'https://example.com/');
  assert.deepEqual(seen.served, { url: { dir: 'dist' } });
  assert.equal(await answers(seen.url), false);

  await assert.rejects(
    withSites({ page: { dir: page, name: 'dist' }, baseline: { dir: baseline, name: 'base' } }, async (sites) => {
      seen = sites;
      assert.equal(await (await fetch(sites.baseline)).text(), 'baseline');
      throw new Error('the audit blew up');
    }),
    /the audit blew up/,
  );
  assert.deepEqual(seen.served, { url: { dir: 'dist' }, baseline: { dir: 'base' } });
  assert.equal(await answers(seen.url), false, 'stopped even though the audit threw');
  assert.equal(await answers(seen.baseline), false);
});

// --- a command --------------------------------------------------------------

test('a command is started, waited for, and stopped — its children with it', async () => {
  const cwd = project();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;

  const server = await startCommand({ command: node('parent.cjs', port), url, cwd });
  assert.equal(await (await fetch(url)).text(), 'served');

  await server.close();
  assert.equal(await answers(url), false, 'the server the shell started is gone too, and the port is free');
});

test('a command that dies before answering says why', async () => {
  const port = await freePort();

  await assert.rejects(
    startCommand({ command: node('crash.cjs'), url: `http://127.0.0.1:${port}/`, cwd: project() }),
    (err) => err instanceof ServeError
      && /exited before http:\/\/127\.0\.0\.1:\d+\/ answered \(code 3\)/.test(err.message)
      && /Cannot find module vite/.test(err.message),
  );
});

test('a command that never answers is given up on, and stopped', async () => {
  const cwd = project();
  const port = await freePort();

  await assert.rejects(
    startCommand({ command: node('idle.cjs'), url: `http://127.0.0.1:${port}/`, cwd, readyTimeoutMs: 600 }),
    /did not answer at http:\/\/127\.0\.0\.1:\d+\/ within 1s/,
  );
});

test('a port something else already answers on is not audited as if Kanso had served it', async () => {
  const other = await serveDirectory(build());
  try {
    await assert.rejects(
      startCommand({ command: node('server.cjs', 1), url: other.url, cwd: project() }),
      /something already answers at http:\/\/127\.0\.0\.1:\d+\/ — stop it before Kanso starts/,
    );
  } finally {
    await other.close();
  }
});

// A GET that leaves the path and the body alone, for what fetch() would tidy up.
function rawGet(url, headers = {}) {
  const { hostname, port, pathname } = new URL(url);
  const path = url.slice(url.indexOf(pathname));
  return new Promise((done, fail) => {
    request({ hostname, port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', fail).end();
  });
}
