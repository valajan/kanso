import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { chromeByMarker, newMarker } from '../chrome.js';

// A Chrome whose launch is not over has no pid to be stopped by yet: it is
// found by the argument it was started with. Any process carrying it will do
// to show it is found, and that another marker finds nothing.
test('a process started with a marker is found by it, and by no other', { skip: process.platform === 'win32' && 'no pgrep' }, async () => {
  const marker = newMarker();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)', '--', `--kanso-launch=${marker}`], { stdio: 'ignore' });
  try {
    await new Promise((resolve) => child.once('spawn', resolve));
    assert.equal(chromeByMarker(marker), child.pid);
    assert.equal(chromeByMarker(newMarker()), undefined);
  } finally {
    child.kill('SIGKILL');
  }
});
