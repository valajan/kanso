import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { FIXTURES, materialize } from './fixtures.mjs';

// Acceptance suite: Kanso, end to end, against the real kanso-frontend build.
//
// What is real: the Nuxt build of the landing page, headless Chrome and
// Lighthouse, the .kanso.yml budgets, and the command a developer or a runner
// types. Nothing is stood in — the CLI serves both builds itself, on loopback,
// which is exactly what the GitHub Action does in a client's runner.
//
// Each audit is a known-answer test: the landing page as shipped must pass, and
// each deliberately regressed variant must fail on exactly the metric it
// regresses. Every step is compared against the unchanged build, the way a
// change is compared against its base — that comparison is what lets the report
// tell a finding this change introduced from one the page already carried.
//
//   npm run test:acceptance
//
// Environment:
//   KANSO_FRONTEND_DIR           path to kanso-frontend  (default ../kanso-frontend)
//   KANSO_ACCEPTANCE_SKIP_BUILD  1 to reuse an existing dist/ instead of building
//   KANSO_ACCEPTANCE_RUNS        Lighthouse runs per audit, median kept (default 3)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KANSO = join(REPO_ROOT, 'bin/kanso.js');
const FRONTEND_DIR = resolve(REPO_ROOT, process.env.KANSO_FRONTEND_DIR ?? '../kanso-frontend');
const RUNS = Number(process.env.KANSO_ACCEPTANCE_RUNS ?? 3);

// One step per change. `fails` lists the metrics that must come out as `fail`,
// `findings` the findings, as `module: rule`, that must be held against the
// change; empty lists mean nothing may fail — the false-positive check.
const STEPS = [
  { fixture: 'baseline', label: 'the landing page as shipped passes', fails: [] },
  { fixture: 'tbt', label: 'a main-thread busy loop fails on TBT', fails: ['tbt'] },
  { fixture: 'cls', label: 'a late-inserted block fails on CLS', fails: ['cls'] },
  { fixture: 'lcp', label: 'an unoptimized hero image fails on LCP', fails: ['lcp'] },
  { fixture: 'reflow', label: 'a block wider than a phone fails on reflow', fails: [], findings: ['accessibility: reflow-scroll'] },
  { fixture: 'baseline', label: 'reverting the regressions passes again', fails: [] },
];

const AUDIT_TIMEOUT_MS = 15 * 60_000;

// Which step regressed TBT, so the Markdown assertions at the end can read the
// report it wrote: one audit, checked twice.
const REPORT_STEP = STEPS.findIndex((step) => step.fails.includes('tbt'));

let workDir;
let configPath;

before(async () => {
  await access(join(FRONTEND_DIR, 'package.json')).catch(() => {
    throw new Error(`kanso-frontend not found at ${FRONTEND_DIR} — clone it there or set KANSO_FRONTEND_DIR`);
  });

  if (process.env.KANSO_ACCEPTANCE_SKIP_BUILD !== '1') {
    const build = await run('npm', ['run', 'build'], { cwd: FRONTEND_DIR });
    if (build.code !== 0) throw new Error(`kanso-frontend build failed:\n${build.output.slice(-4000)}`);
  }

  const distDir = join(FRONTEND_DIR, 'dist');
  const index = await readFile(join(distDir, 'index.html'), 'utf8').catch(() => null);
  // The suite audits static files. If the landing stops being prerendered, the
  // build has no index.html and there is nothing to serve.
  if (!index) throw new Error(`${distDir}/index.html is missing — is the landing page still prerendered?`);

  workDir = await mkdtemp(join(tmpdir(), 'kanso-acceptance-'));

  // The repo's own budgets, at the run count the suite asks for. The reference
  // is always the unchanged build beside it, never a deployment: the suite
  // reaches out to nothing.
  const repoConfig = yaml.load(await readFile(join(FRONTEND_DIR, '.kanso.yml'), 'utf8').catch(() => '')) ?? {};
  const testConfig = { ...repoConfig, runs: RUNS };
  configPath = join(workDir, 'kanso.yml');
  await writeFile(configPath, yaml.dump(testConfig));

  // Each fixture is a directory of built files, which the CLI serves itself —
  // there is no preview host to stand in for.
  for (const id of new Set(STEPS.map((s) => s.fixture))) {
    await materialize(id, distDir, join(workDir, id));
  }
}, { timeout: 10 * 60_000 });

after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// --- known-answer audits -------------------------------------------------------

for (const [index, step] of STEPS.entries()) {
  test(`${index + 1}. ${step.label}`, { timeout: AUDIT_TIMEOUT_MS }, async (t) => {
    const outDir = `out/${index}-${step.fixture}`;
    const res = await run(process.execPath, [
      KANSO, 'audit', step.fixture,
      '--baseline', 'baseline',
      '--config', configPath,
      '--fail-on', 'fail',
      '--out', `${outDir}/report.md`,
      '--out', `${outDir}/result.json`,
    ], { cwd: workDir });

    const result = JSON.parse(await readFile(join(workDir, outDir, 'result.json'), 'utf8').catch(() => 'null'));
    assert.ok(result, `the CLI wrote no result:\n${res.output.slice(-4000)}`);

    t.diagnostic(`${FIXTURES[step.fixture].description} → ${result.conclusion}`);
    for (const line of describeScores(result)) t.diagnostic(line);

    assert.equal(result.ok, true, `audit did not complete: ${result.error}`);
    // Both sides were served by Kanso, from the directories the command named.
    assert.deepEqual(result.served, { url: { dir: step.fixture }, baseline: { dir: 'baseline' } });

    const failing = Object.entries(result.modules.performance?.levels ?? {})
      .filter(([, level]) => level === 'fail')
      .map(([metric]) => metric);

    // Findings the reference already has must never fail a change: a repo with
    // existing violations would otherwise be red on every change, and the report
    // would be read as noise within a week. That holds for every module that
    // reports findings — only the step that breaks a rule on purpose may have
    // one held against it, and only that one.
    const findings = Object.entries(result.modules ?? {})
      .flatMap(([id, mod]) => (mod.findings ?? []).map((finding) => ({ id, ...finding })));
    assert.ok(
      result.modules.accessibility?.findings?.some((finding) => finding.rule === 'image-alt' && finding.state === 'inherited' && finding.level === 'pass'),
      'the violation every fixture carries came out inherited and unheld — this is what proves an inherited finding fails no step'
    );
    assert.deepEqual(
      findings.filter((finding) => finding.level !== 'pass').map((finding) => `${finding.id}: ${finding.rule}`),
      step.findings ?? [],
      'a finding the reference already has was held against the change, or the one this step added was missed'
    );
    for (const finding of findings.filter((f) => f.level !== 'pass')) {
      assert.equal(finding.state, 'new', `${finding.rule} was added by this step`);
      t.diagnostic(`${finding.id}: ${finding.rule} ${finding.state} ${finding.level} — ${finding.nodes.map((node) => node.explanation).join(' | ')}`);
    }
    assert.deepEqual(
      Object.values(result.modules ?? {}).flatMap((mod) => mod.probeFailures ?? []),
      [],
      'every probe ran, on both pages'
    );

    if (step.fails.length === 0 && (step.findings ?? []).length === 0) {
      assert.deepEqual(failing, [], `false positive — unchanged page failed on ${failing.join(', ')}`);
      assert.equal(res.code, 0, 'the CLI must exit 0 when nothing fails');
    } else {
      for (const metric of step.fails) {
        assert.ok(
          failing.includes(metric),
          `${metric} regression not detected (failing: ${failing.join(', ') || 'none'}) — ` +
            `if the audit saw it but passed it, the ${metric} budget in kanso-frontend's .kanso.yml is too loose to catch it`
        );
      }
      assert.equal(res.code, 1, 'the CLI must exit 1 so the pipeline fails');
    }
  });
}

// --- the report a job summary shows ---------------------------------------------

// `--out report.md` is what the GitHub Action pipes into the job summary, so the
// Markdown is checked against a real audit rather than a synthetic one: the TBT
// step above, read a second time.
test('the regressed step wrote a report naming both sides and the failing metric', async () => {
  const step = STEPS[REPORT_STEP];
  const report = await readFile(join(workDir, `out/${REPORT_STEP}-${step.fixture}`, 'report.md'), 'utf8');

  assert.match(report, /^## Kanso \| Audit Report$/m);
  assert.match(report, /🔗 `tbt` against `baseline`/);
  // Budget, baseline, current, Δ: the budget is what the ❌ was read against.
  assert.match(report, /\| Metric \| budget \| baseline \| current \| Δ \| \|/);
  assert.match(report, /\| TBT \| \d+ms \| \d+ms \| \d+ms \| \+\d+ms \| ❌ \|/);
  assert.match(report, /### 📱 Mobile/);
  assert.match(report, /### 💻 Desktop/);
});

// --- helpers --------------------------------------------------------------------

function run(command, args, { cwd, env = process.env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolvePromise({ code, output }));
  });
}

function describeScores(result) {
  const lines = [];
  for (const [formFactor, sides] of Object.entries(result.modules?.performance?.scores ?? {})) {
    const s = sides?.current;
    if (!s) {
      lines.push(`  ${formFactor.padEnd(7)} audit failed`);
      continue;
    }
    lines.push(
      `  ${formFactor.padEnd(7)} perf ${Math.round(s.performance)} · LCP ${Math.round(s.lcp)}ms · ` +
        `TBT ${Math.round(s.tbt)}ms · CLS ${s.cls.toFixed(3)} · FCP ${Math.round(s.fcp)}ms`
    );
  }
  const levels = Object.entries(result.modules?.performance?.levels ?? {}).map(([m, l]) => `${m}:${l}`).join(' ');
  if (levels) lines.push(`  levels ${levels}`);
  return lines;
}
