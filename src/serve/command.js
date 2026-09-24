import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { signalGroup, stopOnExit } from '../process/children.js';

// How long a server gets to answer before Kanso gives up on it. A preview
// server is up in a second or two; a worker runtime such as Wrangler takes
// several, and a cold CI runner more.
const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const STOP_GRACE_MS = 5_000;

// What is kept of the server's output, to say why it never answered.
const OUTPUT_KEPT = 4_000;

// Starts the command that serves the project, waits until `url` answers, and
// returns a handle that stops it. Kanso only audits a server it started: it is
// the only way to know what is being measured.
//
// The command runs in a shell, in its own process group. `npm run preview` is a
// shell running npm running the server, and stopping the shell alone would
// leave the server holding the port for the next audit.
export async function startCommand({ command, url, cwd, readyTimeoutMs = READY_TIMEOUT_MS }) {
  if (await answers(url)) {
    throw new ServeError(`something already answers at ${url} — stop it before Kanso starts \`${command}\`, or audit that URL directly`);
  }

  const child = spawn(command, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const keep = (chunk) => { output = (output + chunk).slice(-OUTPUT_KEPT); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);

  const exited = new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', (err) => done({ error: err }));
  });
  // A server lives in its own process group, so a Ctrl-C in the terminal
  // reaches Kanso and not the server: whatever ends Kanso ends it first, or
  // the next audit finds the port taken.
  const release = stopOnExit(child.pid);

  const stop = async () => {
    await terminate(child, exited);
    release();
  };

  try {
    await ready({ url, exited, timeoutMs: readyTimeoutMs });
  } catch (err) {
    await stop();
    const tail = output.trim();
    throw new ServeError(`\`${command}\` ${err.message}${tail ? `. Its last output:\n${tail}` : ''}`);
  }

  return { url, close: stop };
}

// Any HTTP answer at all means a server is up; what it answers is Lighthouse's
// to judge.
async function answers(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function ready({ url, exited, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  exited.then((result) => { status = result; });

  while (Date.now() < deadline) {
    if (status) {
      if (status.error) throw new Error(`could not start: ${status.error.message}`);
      throw new Error(`exited before ${url} answered (${status.signal ?? `code ${status.code}`})`);
    }
    if (await answers(url)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s`);
}

// Asks the whole group to stop, then makes sure of it: a server that ignores
// SIGTERM still has to give the port back.
async function terminate(child, exited) {
  if (child.exitCode === null && child.signalCode === null) {
    signal(child, 'SIGTERM');
    // Unreferenced: a server that stopped at once must not hold Kanso open for
    // the rest of the grace period.
    await Promise.race([exited, sleep(STOP_GRACE_MS, undefined, { ref: false })]);
  }
  signal(child, 'SIGKILL');
}

function signal(child, name) {
  signalGroup(child.pid, name);
}

// Signals a project that could not be served as configured. Each surface
// reports it as the audit failing to run, with this message.
export class ServeError extends Error {}
