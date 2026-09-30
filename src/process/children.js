import { spawn } from 'node:child_process';

// The processes Kanso starts and must not leave behind: the servers it serves
// a project with (src/serve/command.js), the Chromes it loads pages in
// (src/runner/runner.worker.js, src/discover/index.js). Each is the leader
// of a process group of its own — a shell and the server under it, a browser
// and its helpers — and is stopped with its group.
//
// Whatever ends Kanso ends them first. A Ctrl-C reaches Kanso alone, since
// they are in groups of their own, and the `finally` that stops each one never
// runs on a signal: without this, an audit interrupted leaves its Chromes
// running, headless and windowless — which macOS then wakes in place of the
// Chrome a person opens, since they are the same application.

const running = new Set();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// Watches over the group `pid` leads until the returned function is called.
// `pid` may be a function that says it when asked: a Chrome being launched
// exists before its launch resolves, and an interruption then must stop it
// too (src/process/chrome.js, `chromeByMarker`).
export function stopOnExit(pid) {
  if (pid === undefined) return () => {};
  if (running.size === 0) {
    process.on('exit', stopAll);
    for (const name of SIGNALS) process.on(name, onSignal);
  }
  running.add(pid);
  return () => {
    running.delete(pid);
    if (running.size === 0) {
      process.off('exit', stopAll);
      for (const name of SIGNALS) process.off(name, onSignal);
    }
  };
}

// Sends `name` to the whole group `pid` leads. A group already gone is
// nothing to stop.
export function signalGroup(pid, name) {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, name);
    }
  } catch {
    // The group is already gone.
  }
}

function stopAll() {
  for (const pid of running) signalGroup(typeof pid === 'function' ? pid() : pid, 'SIGKILL');
}

// Stops them all, then lets the signal do what it would have done.
function onSignal(name) {
  stopAll();
  running.clear();
  process.off('exit', stopAll);
  for (const signal of SIGNALS) process.off(signal, onSignal);
  process.kill(process.pid, name);
}
