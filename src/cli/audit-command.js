import { audit } from '../core/audit.js';
import { clampRuns, MAX_RUNS } from '../core/runs.js';
import { loadCliConfig } from './config.js';
import { renderResult } from './render.js';

export const EXIT = { ok: 0, failed: 1, error: 2 };

const SEVERITY = { pass: 0, warn: 1, fail: 2 };

// Runs one audit and reports it on `io`. Returns the process exit code, so a
// local run and a CI run of the same command fail on the same thing.
//
// `runLighthouse` and `now` are injected for the tests; everything else the
// command needs, it resolves itself.
export async function runAuditCommand({ url, baseline = null, runs = null, configPath = null, failOn = 'fail', json = false, cwd, io, runLighthouse, now = Date.now }) {
  // No URL guard here, unlike the server: the guard exists because /v1/audit is
  // a public endpoint that must not be pointed at private addresses on the
  // operator's behalf. On a developer's machine, a private address is the point.
  const target = parseTarget(url, 'url');
  const reference = baseline ? parseTarget(baseline, 'baseline') : null;

  const { config, source } = loadCliConfig({ cwd, configPath });
  // Clamped here as well as in the core, so the run count printed in the
  // report is the one the audit will really do.
  config.runs = clampRuns(runs ?? config.runs);
  if (!json && source) io.stderr.write(`using ${source}\n`);

  const started = now();
  const stopTicking = tick(io, json, started, now);
  let result;
  try {
    // A baseline typed on the command line is always audited: the comparison
    // is what the developer asked for, even when the budgets alone settle the
    // verdict.
    result = await audit({ url: target, baseline: reference, config, runLighthouse, alwaysCompare: true });
  } finally {
    stopTicking();
  }
  const elapsedMs = now() - started;

  if (json) {
    io.stdout.write(JSON.stringify({ url: target, baseline: reference, elapsedMs, ...result }, null, 2) + '\n');
  } else {
    io.stdout.write(renderResult({ url: target, baseline: reference, result, config, elapsedMs, color: Boolean(io.stdout.isTTY) }));
  }

  if (!result.ok) return EXIT.error;
  return SEVERITY[result.conclusion] >= SEVERITY[failOn] ? EXIT.failed : EXIT.ok;
}

// An audit is minutes of silence otherwise, which reads as a hung command.
function tick(io, json, started, now) {
  if (json || !io.stderr.isTTY) return () => {};
  const write = () => io.stderr.write(`\rauditing… ${Math.round((now() - started) / 1000)}s`);
  write();
  const timer = setInterval(write, 1000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    io.stderr.write('\r\x1b[K');
  };
}

function parseTarget(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UsageError(`${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`${label} must be http or https: ${value}`);
  }
  return parsed.href;
}

export function parseRuns(value) {
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new UsageError(`runs must be a whole number between 1 and ${MAX_RUNS}`);
  }
  return runs;
}

export function parseFailOn(value) {
  if (!['warn', 'fail'].includes(value)) throw new UsageError('fail-on must be warn or fail');
  return value;
}

// Signals a mistake in the invocation: reported with the usage hint and no
// stack trace, since the fix is in the command line, not in Kanso.
export class UsageError extends Error {}
