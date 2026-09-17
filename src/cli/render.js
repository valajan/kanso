import { moduleConfig } from '../config/module-config.js';
import { FORM_FACTORS } from '../core/audit.js';
import { checkLabel, MODULES } from '../modules/index.js';
import { METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses } from '../modules/performance/status.js';

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
  const refLabel = moduleResult.referenceKind === 'budgets' ? 'budget' : 'baseline';
  const lines = [];

  for (const [formFactor, { current, reference }] of Object.entries(moduleResult.scores)) {
    lines.push('', c('dim', formFactor));
    if (current == null) {
      lines.push('  ' + c('dim', 'no result'));
      continue;
    }
    const rows = metricRows(current, reference, config.budgets ?? {}, refLabel);
    lines.push(...table(rows, ['left', 'right', 'right', 'right', 'left'], c));
  }

  return lines;
}

function metricRows(current, reference, budget, refLabel) {
  const scored = roundScore(current);
  const ref = roundScore(reference);
  const statuses = evaluateStatuses(scored, budget);

  const header = [{ text: '' }, { text: refLabel, color: 'dim' }, { text: 'current', color: 'dim' }, { text: 'Δ', color: 'dim' }, { text: '' }];
  return [header, ...METRICS.map((metric) => {
    const value = scored[metric.key];
    const against = ref?.[metric.key] ?? null;
    const delta = value != null && against != null ? value - against : null;
    const level = statuses[metric.key];
    return [
      { text: metric.label },
      { text: format(metric, against) },
      { text: format(metric, value), color: LEVEL_COLOR[level] },
      { text: delta == null ? '—' : (delta >= 0 ? '+' : '') + format(metric, delta) },
      { text: level, color: LEVEL_COLOR[level] },
    ];
  })];
}

// One line per broken rule, worst first, with the elements to go and look at
// under the ones that count. The rows are built first and padded together, then
// the elements are slipped back under their own row.
function renderFindings({ findings, fixed = [], comparedToBaseline, failOn }, c) {
  if (findings == null) return ['', '  ' + c('dim', 'no result')];
  if (findings.length === 0) {
    return ['', '  ' + c('green', 'no findings'), '', '  ' + c('dim', summary({ findings, fixed, comparedToBaseline, failOn }))];
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
    // A rule Lighthouse failed without naming an element has nothing to list.
    if (finding.level === 'pass' || finding.nodes.length === 0) return;
    for (const node of finding.nodes.slice(0, ELEMENTS_SHOWN)) {
      lines.push('      ' + c('dim', node.selector || node.snippet));
    }
    const rest = finding.count - Math.min(finding.nodes.length, ELEMENTS_SHOWN);
    if (rest > 0) lines.push('      ' + c('dim', `… and ${rest} more`));
  });

  lines.push('', '  ' + c('dim', summary({ findings, fixed, comparedToBaseline, failOn })));
  return lines;
}

// Says what the numbers were judged against, which is the difference between a
// clean page and a page whose findings were all there before.
function summary({ findings, fixed, comparedToBaseline, failOn }) {
  const parts = [`failing from ${failOn} up`];
  if (comparedToBaseline) {
    const inherited = findings.filter((f) => f.state === 'inherited').length;
    parts.push(`${inherited} already in the baseline`, `${fixed.length} fixed`);
  }
  return parts.join(' · ');
}

function elements(finding) {
  const grew = finding.state === 'worse' ? ` (+${finding.count - finding.baselineCount})` : '';
  return `${finding.count} element${finding.count === 1 ? '' : 's'}${grew}`;
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
