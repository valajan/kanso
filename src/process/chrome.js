import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

import { signalGroup } from './children.js';

// The Chrome Kanso loads pages in: the one installed on the machine — Google
// Chrome, or what CHROME_PATH names — driven through Playwright, headless.
// Not a browser Playwright downloads: a page is audited in the Chrome its
// visitors run.
//
// Playwright starts it detached, the leader of a process group of its own —
// the browser and its helpers — which is how src/process/children.js stops
// it. Its pid is only known once the launch is over, a few hundred ms after
// it was spawned: until then it is found by the marker it is started with
// (`chromeByMarker`), an argument Chrome ignores and no other process carries.

// A marker for one Chrome to be launched.
export function newMarker() {
  return randomUUID();
}

// Launches Chrome, marked with `marker`. Resolves to { browser, pid, close }:
// `browser` a Playwright Browser, `close()` stops Chrome and everything it
// spawned, whatever state it is in.
export async function launchChrome({ marker = newMarker() } = {}) {
  let server;
  try {
    server = await chromium.launchServer({
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      headless: true,
      args: [markerArg(marker)],
    });
  } catch (err) {
    if (/is not found|Failed to launch|ENOENT/.test(err?.message ?? '')) {
      throw new Error(`could not start Google Chrome, which Kanso audits pages in: install it, or name another Chrome with CHROME_PATH (${firstLine(err)})`);
    }
    throw err;
  }
  const pid = server.process().pid;
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return {
      browser,
      pid,
      async close() {
        await browser.close().catch(() => {});
        await server.kill().catch(() => {});
        signalGroup(pid, 'SIGKILL');
      },
    };
  } catch (err) {
    await server.kill().catch(() => {});
    signalGroup(pid, 'SIGKILL');
    throw err;
  }
}

// The pid of the Chrome launched with `marker`, or undefined when there is
// none — not yet spawned, or gone. Synchronous: it is asked from an exit or a
// signal handler, where nothing can be awaited.
export function chromeByMarker(marker) {
  if (process.platform === 'win32') return undefined;
  try {
    const out = execFileSync('pgrep', ['-f', '--', markerArg(marker)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(out.split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function markerArg(marker) {
  return `--kanso-launch=${marker}`;
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
