import { FORM_FACTORS } from '../core/audit.js';
import { MODULES } from '../modules/index.js';
import { METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses } from '../modules/performance/status.js';

const CODES = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m',
};

const LEVEL_COLOR = { pass: 'green', warn: 'yellow', fail: 'red' };

const MODULE_LABELS = Object.fromEntries(MODULES.map((m) => [m.id, m.label]));

// Check names are a module's own vocabulary; performance's happen to be metric
// keys, and reading "LCP" beats reading "lcp".
const METRIC_LABELS = Object.fromEntries(METRICS.map((m) => [m.key, m.label]));

export function renderResult({ url, baseline, result, config = {}, elapsedMs = null, color = false }) {
  const c = (name, text) => (color && name ? CODES[name] + text + CODES.reset : text);
  const out = [''];

  out.push(`${c('bold', 'Kanso')} · ${url}`, c('dim', subtitle({ baseline, config, elapsedMs })), '');

  if (!result.ok) {
    out.push(`${c('red', 'error')} · ${result.error}`, '');
    return out.join('\n');
  }

  for (const [id, moduleResult] of Object.entries(result.modules)) {
    out.push(...renderModule(id, moduleResult, config, c), '');
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

// Until a second module lands and settles a shared shape for module detail,
// the renderer knows exactly one: `scores`, the per-form-factor measures
// performance produces. Any other module falls back to its levels, which is
// the only part of the contract the core itself relies on.
function renderModule(id, moduleResult, config, c) {
  const label = MODULE_LABELS[id] ?? id;
  const head = `${c('bold', label)}  ${c(LEVEL_COLOR[moduleResult.conclusion], moduleResult.conclusion)}`;

  if (!moduleResult.scores) {
    const rows = Object.entries(moduleResult.levels).map(([check, level]) => [
      { text: checkLabel(check) }, { text: level, color: LEVEL_COLOR[level] },
    ]);
    return [head, '', ...table(rows, ['left', 'left'], c)];
  }

  const refLabel = moduleResult.referenceKind === 'budgets' ? 'budget' : 'baseline';
  const lines = [head];
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

function format(metric, value) {
  if (value == null) return '—';
  return value.toFixed(metric.decimals) + metric.unit;
}

function checkLabel(check) {
  return METRIC_LABELS[check] ?? check;
}

function verdictLine(result, c) {
  const level = result.conclusion;
  const checks = Object.values(result.modules).flatMap((m) =>
    Object.entries(m.levels).filter(([, l]) => l === level).map(([check]) => checkLabel(check))
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
