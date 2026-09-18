import { moduleConfig } from '../config/module-config.js';
import { FORM_FACTORS } from '../core/audit.js';
import { countLabel, elementHint, elementWhere, explanationLine, sharedExplanation } from '../modules/findings.js';
import { checkLabel, MODULES } from '../modules/index.js';
import { METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses, failThreshold } from '../modules/performance/status.js';

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
};

const LEVEL_COLOR = { pass: 'green', warn: 'yellow', fail: 'red' };

const MODULE_LABELS = Object.fromEntries(MODULES.map((m) => [m.id, m.label]));

// Elements listed under a finding before the rest is left to the report. Enough
// to know where to start; a page failing contrast on forty nodes has one
// problem, not forty.
const ELEMENTS_SHOWN = 3;

export function renderResult({ url, baseline, result, config = {}, elapsedMs = null, color = false }) {
  const c = (name, text) => (color && name ? CODES[name] + text + CODES.reset : text);
  const out = [''];

  out.push(`${c('bold', 'Kanso')} · ${url}`, c('dim', subtitle({ baseline, config, elapsedMs })), '');

  if (!result.ok) {
    out.push(`${c('red', 'error')} · ${result.error}`, '');
    return out.join('\n');
  }

  for (const [id, moduleResult] of Object.entries(result.modules)) {
    out.push(...renderModule(id, moduleResult, moduleConfig(config, id), c), '');
  }

  for (const failure of result.failures) {
    const side = failure.side === 'current' ? 'page' : 'baseline';
    out.push(c('yellow', `! the ${failure.formFactor} ${side} load failed: ${failure.error}`));
  }
  if (result.failures.length > 0) out.push('');

  out.push(verdictLine(result, c), '');
  return out.join('\n');
}

function subtitle({ baseline, config, elapsedMs }) {
  const runs = config.runs ?? 1;
  const parts = [
    baseline ? `against ${baseline}` : 'against the configured budgets',
    FORM_FACTORS.join(' + '),
    `${runs} run${runs > 1 ? 's' : ''} per page`,
  ];
  if (elapsedMs != null) parts.push(`${Math.round(elapsedMs / 1000)}s`);
  return parts.join(' · ');
}

// A module reports measures, findings, or neither — see src/modules/index.js.
// Anything that reports neither falls back to its levels, which is the only
// part of the contract the core itself relies on.
function renderModule(id, moduleResult, config, c) {
  const label = MODULE_LABELS[id] ?? id;
  const lines = [`${c('bold', label)}  ${c(LEVEL_COLOR[moduleResult.conclusion], moduleResult.conclusion)}`];

  if (moduleResult.scores) lines.push(...renderScores(moduleResult, config, c));
  if (moduleResult.findings !== undefined) lines.push(...renderFindings(moduleResult, c));

  if (!moduleResult.scores && moduleResult.findings === undefined) {
    const rows = Object.entries(moduleResult.levels).map(([check, level]) => [
      { text: checkLabel(id, check) }, { text: level, color: LEVEL_COLOR[level] },
    ]);
    lines.push('', ...table(rows, ['left', 'left'], c));
  }

  return lines;
}

function renderScores(moduleResult, config, c) {
  const againstBaseline = moduleResult.referenceKind === 'baseline';
  const lines = [];

  for (const [formFactor, { current, reference }] of Object.entries(moduleResult.scores)) {
    lines.push('', c('dim', formFactor));
    if (current == null) {
      lines.push('  ' + c('dim', 'no result'));
      continue;
    }
    const budget = config.budgets ?? {};
    const rows = metricRows(current, againstBaseline ? reference : null, budget);
    lines.push(...table(rows, ['left', ...rows[0].slice(1, -1).map(() => 'right'), 'left'], c));

    const statuses = evaluateStatuses(roundScore(current), budget);
    const why = diagnosticRows(moduleResult.diagnostics?.[formFactor]?.current, statuses);
    if (why.length > 0) lines.push('', ...table(why, ['left', 'left'], c));
  }

  return lines;
}

// How Lighthouse names the parts of an LCP, in the words of a sentence.
const LCP_SUBPARTS = {
  timeToFirstByte: 'to first byte',
  resourceLoadDelay: 'load delay',
  resourceLoadDuration: 'load duration',
  elementRenderDelay: 'render delay',
};

// Why a metric that did not pass is what it is, from Lighthouse's diagnostics
// — src/modules/performance/diagnostics.js. A metric that passed needs no
// explaining, and gets none.
function diagnosticRows(diagnostics, statuses) {
  if (!diagnostics) return [];
  const { lcp, renderBlocking = [], cls } = diagnostics;
  const rows = [];
  const row = (label, text) => rows.push([{ text: label, color: 'dim' }, { text }]);

  if (statuses.lcp !== 'pass' && lcp) {
    if (lcp.element) row('LCP element', describe(lcp.element));
    const parts = Object.entries(lcp.subparts).map(([part, ms]) => `${ms}ms ${LCP_SUBPARTS[part] ?? part}`);
    row('LCP, observed', `${lcp.observedMs}ms = ${parts.join(' + ')}`);
  }
  // A stylesheet the first render waits for delays the LCP as much as the FCP.
  if (statuses.lcp !== 'pass' || statuses.fcp !== 'pass') {
    renderBlocking.forEach(({ url, wastedMs }, i) => row(i === 0 ? 'render-blocking' : '', `${url}  ${wastedMs ?? '?'}ms`));
  }
  if (statuses.cls !== 'pass' && cls) {
    cls.shifts.forEach((shift, i) => row(i === 0 ? 'layout shifts' : '', [
      shift.element ? describe(shift.element) : '?',
      shift.score.toFixed(3),
      ...shift.causes.map(({ cause, element, url }) => [cause, element ? describe(element) : url].filter(Boolean).join(': ')),
    ].join('  ')));
  }

  return rows;
}

// An element by where it is, and by what tells it apart from the others
// sharing that selector: its text, or its tag when it has none.
function describe(element) {
  const hint = elementHint(element);
  const detail = hint?.text ? `"${hint.text}"` : hint?.tag;
  return elementWhere(element) + (detail ? `  ${detail}` : '');
}

// One row per metric: the budget it is judged against, always — and when a
// baseline was loaded, that page's value too, which is then what Δ measures
// from. Without the budget beside a baseline, a metric equal to the baseline
// can read `fail` with nothing on the line saying why.
function metricRows(current, baseline, budget) {
  const scored = roundScore(current);
  const ref = roundScore(baseline);
  const statuses = evaluateStatuses(scored, budget);

  const dim = (text) => ({ text, color: 'dim' });
  const header = [dim(''), dim('budget'), ...(baseline ? [dim('baseline')] : []), dim('current'), dim('Δ'), dim('')];
  return [header, ...METRICS.map((metric) => {
    const value = scored[metric.key];
    const threshold = failThreshold(metric, budget);
    const against = baseline ? ref?.[metric.key] ?? null : threshold;
    const delta = value != null && against != null ? value - against : null;
    const level = statuses[metric.key];
    return [
      { text: metric.label },
      { text: format(metric, threshold) },
      ...(baseline ? [{ text: format(metric, against) }] : []),
      { text: format(metric, value), color: LEVEL_COLOR[level] },
      { text: delta == null ? '—' : (delta >= 0 ? '+' : '') + format(metric, delta) },
      { text: level, color: LEVEL_COLOR[level] },
    ];
  })];
}

// One line per broken rule, worst first, with the elements to go and look at
// under the ones that count. The rows are built first and padded together, then
// the elements are slipped back under their own row.
function renderFindings(moduleResult, c) {
  const { findings } = moduleResult;
  if (findings == null) return ['', '  ' + c('dim', 'no result')];
  if (findings.length === 0) {
    return ['', '  ' + c('green', 'no findings'), '', '  ' + c('dim', summary(moduleResult)), ...unchecked(moduleResult, c)];
  }

  // The state column only exists when a baseline gave the findings one.
  const compared = findings.some((finding) => finding.state);
  const rows = findings.map((finding) => [
    { text: finding.rule + partialSuffix(finding) },
    { text: finding.impact ?? '—', color: 'dim' },
    { text: elements(finding) },
    ...(compared ? [{ text: finding.state ?? '', color: 'dim' }] : []),
    { text: finding.level, color: LEVEL_COLOR[finding.level] },
  ]);

  const lines = [''];
  table(rows, rows[0].map(() => 'left'), c).forEach((line, i) => {
    lines.push(line);
    const finding = findings[i];
    if (finding.level === 'pass') return;
    // A rule that failed as a whole — no doctype — is explained here, if at all.
    if (finding.detail) lines.push('      ' + finding.detail);
    const shown = finding.nodes.slice(0, ELEMENTS_SHOWN);
    const shared = sharedExplanation(shown);
    if (shared) lines.push('      ' + shared);
    for (const node of shown) {
      const where = describe(node);
      const explanation = shared ? '' : explanationLine(node.explanation);
      // A tag the page lacks is nowhere: its explanation is all there is.
      if (!where) {
        if (explanation) lines.push('      ' + explanation);
        continue;
      }
      lines.push('      ' + c('dim', where));
      if (explanation) lines.push('        ' + explanation);
    }
    const rest = finding.count - shown.length;
    if (rest > 0) lines.push('      ' + c('dim', `… and ${rest} more`));
  });

  lines.push('', '  ' + c('dim', summary(moduleResult)), ...unchecked(moduleResult, c));
  return lines;
}

// A probe that did not run checked nothing: said, with the rules it left
// unchecked, so that a clean section is never read as a clean page.
function unchecked({ probeFailures = [] }, c) {
  return probeFailures.map(({ probe, rules, side, formFactor, error }) => '  ' + c('yellow',
    `! ${probe} did not run on the ${formFactor} ${side === 'current' ? 'page' : 'baseline'} (${error}): ${rules.join(', ')} unchecked`));
}

// Says what the numbers were judged against, which is the difference between a
// clean page and a page whose findings were all there before — and what was
// left out of the judging.
function summary({ findings, fixed = [], comparedToBaseline, failOn, ignore = [] }) {
  const parts = [`failing from ${failOn} up`];
  if (comparedToBaseline) {
    // Only worth counting when there is something to count.
    if (findings.length > 0) {
      const inherited = findings.filter((f) => f.state === 'inherited').length;
      parts.push(`${inherited} already in the baseline`);
    }
    parts.push(`${fixed.length} fixed`);
  }
  if (ignore.length > 0) parts.push(`ignoring ${ignore.join(', ')}`);
  return parts.join(' · ');
}

function elements(finding) {
  const grew = finding.state === 'worse' ? ` (+${finding.count - finding.baselineCount})` : '';
  return countLabel(finding) + grew;
}

// A rule broken on one form factor only is worth saying so.
function partialSuffix({ formFactors }) {
  return formFactors.length < FORM_FACTORS.length ? ` (${formFactors.join(' + ')})` : '';
}

function format(metric, value) {
  if (value == null) return '—';
  return value.toFixed(metric.decimals) + metric.unit;
}

function verdictLine(result, c) {
  const level = result.conclusion;
  const checks = Object.entries(result.modules).flatMap(([id, m]) =>
    Object.entries(m.levels).filter(([, l]) => l === level).map(([check]) => checkLabel(id, check))
  );
  const reason = level === 'pass' ? 'everything within budget' : [...new Set(checks)].join(', ');
  return `${c(LEVEL_COLOR[level], c('bold', level))} · ${reason}`;
}

// Pads on the plain text, then colours, so escape codes never count as width.
function table(rows, aligns, c, indent = '  ') {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].text.length)));
  return rows.map((row) => indent + row
    .map((cell, i) => {
      const pad = ' '.repeat(widths[i] - cell.text.length);
      const text = aligns[i] === 'right' ? pad + cell.text : cell.text + pad;
      return c(cell.color, text);
    })
    .join('  ')
    .trimEnd());
}
