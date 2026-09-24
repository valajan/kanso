import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { loadLocalConfig } from '../config/local-config.js';
import { audit } from '../core/audit.js';
import { clearRecord, writeRecord } from '../core/record.js';
import { clampRuns, MAX_RUNS } from '../core/runs.js';
import { InvalidTarget } from '../core/target.js';
import { siteFromArgument, siteFromConfig, siteName, withSites } from '../serve/index.js';
import { renderMarkdown } from './markdown.js';
import { renderResult } from './render.js';

export const EXIT = { ok: 0, failed: 1, error: 2 };

const SEVERITY = { pass: 0, warn: 1, fail: 2 };

// What `--out` knows how to write, by the file's extension.
const OUT_FORMATS = {
  '.md': (report) => renderMarkdown(report),
  '.json': (report) => JSON.stringify(jsonResult(report), null, 2) + '\n',
};

// Runs one audit and reports it on `io`, and in every file `out` names. Returns
// the process exit code, so a local run and a CI run of the same command fail
// on the same thing.
//
// `target` and `baseline` are what the command line named: a URL, or a
// directory of built files Kanso serves itself. With no target, the project's
// .kanso.yml says how to serve it — see src/serve/index.js.
//
// `record` is a directory where each load's journal goes
// (src/probes/journal.js), the result beside them as audit.json, and the page
// that shows them, index.html (src/core/record.js).
//
// `runLighthouse` and `now` are injected for the tests; everything else the
// command needs, it resolves itself.
export async function runAuditCommand({ target = null, baseline = null, runs = null, configPath = null, failOn = 'fail', json = false, out = [], record = null, cwd, io, runLighthouse, now = Date.now }) {
  // No URL guard here, unlike the server: see src/core/target.js.
  const named = target == null ? null : usage(() => siteFromArgument(target, 'target', cwd));
  const reference = baseline == null ? null : usage(() => siteFromArgument(baseline, 'baseline', cwd));
  const outputs = out.map((path) => {
    const format = OUT_FORMATS[extname(path).toLowerCase()];
    if (!format) throw new UsageError(`--out writes a .md or a .json file, not ${path}`);
    return { path: resolve(cwd, path), format };
  });

  const { config, source } = loadLocalConfig({ cwd, configPath });
  const page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
  if (!page) throw new UsageError('audit needs a URL or a directory, or a serve: block in .kanso.yml saying how to serve the project');

  // Clamped here as well as in the core, so the run count printed in the
  // report is the one the audit will really do.
  config.runs = clampRuns(runs ?? config.runs);
  if (!json && source) io.stderr.write(`using ${source}\n`);
  if (!json && page.command) io.stderr.write(`starting ${page.command}\n`);

  // Cleared only once the audit is sure to run: a command line with a mistake
  // in it leaves an earlier record as it was.
  const recordDir = record == null ? null : resolve(cwd, record);
  if (recordDir) clearRecord(recordDir);

  const started = now();
  const stopTicking = tick(io, json, started, now);
  let report;
  try {
    report = await withSites({ page, baseline: reference }, async ({ url, baseline: against, served }) => {
      // A baseline typed on the command line is always audited: the comparison
      // is what the developer asked for, even when the budgets alone settle the
      // verdict.
      const result = await audit({ url, baseline: against, config, runLighthouse, alwaysCompare: true, record: recordDir });
      return { url, baseline: against, served, result, config };
    });
  } finally {
    stopTicking();
  }
  report.elapsedMs = now() - started;

  if (json) {
    io.stdout.write(JSON.stringify(jsonResult(report), null, 2) + '\n');
  } else {
    io.stdout.write(renderResult({
      ...report,
      url: siteName(report.url, report.served?.url),
      baseline: report.baseline && siteName(report.baseline, report.served?.baseline),
      color: Boolean(io.stdout.isTTY),
    }));
  }

  for (const { path, format } of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, format(report));
  }
  if (recordDir) {
    const page = writeRecord(recordDir, jsonResult(report));
    if (!json) io.stderr.write(`journal kept in ${recordDir} — open ${page}\n`);
  }

  const { result } = report;
  if (!result.ok) return EXIT.error;
  return SEVERITY[result.conclusion] >= SEVERITY[failOn] ? EXIT.failed : EXIT.ok;
}

// The result as `--json` prints it: what was loaded, how it was served when
// Kanso served it, and the audit.
function jsonResult({ url, baseline, served, elapsedMs, result }) {
  return { url, baseline, ...(served ? { served } : {}), elapsedMs, ...result };
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

// A target the command line named wrong is a mistake in the invocation, and
// reads as one: the message, and the pointer to --help.
function usage(parse) {
  try {
    return parse();
  } catch (err) {
    if (err instanceof InvalidTarget) throw new UsageError(err.message);
    throw err;
  }
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
