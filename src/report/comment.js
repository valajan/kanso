import { METRICS, roundScore } from '../metrics/registry.js';
import { evaluateStatuses, metricsWithStatus } from '../metrics/status.js';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

const FORM_FACTOR_LABELS = {
  mobile:  { icon: '📱', label: 'Mobile' },
  desktop: { icon: '💻', label: 'Desktop' },
};

function formatValue(metric, value) {
  return value.toFixed(metric.decimals) + metric.unit;
}

function formatRef(metric, value) {
  return value == null ? '—' : formatValue(metric, value);
}

function formatDelta(metric, delta) {
  return (delta >= 0 ? '+' : '') + delta.toFixed(metric.decimals) + metric.unit;
}

// Computes an overall verdict summary across both form factors.
function computeVerdict(scores, budget) {
  const allStatuses = [];
  for (const ff of ['mobile', 'desktop']) {
    const pr = scores[ff]?.pr;
    if (!pr) continue;
    const rounded = roundScore(pr);
    const statuses = evaluateStatuses(rounded, budget);
    allStatuses.push(statuses);
  }
  if (allStatuses.length === 0) return '';

  const failKeys = [...new Set(allStatuses.flatMap((s) => metricsWithStatus(s, 'fail')))];
  const warnKeys = [...new Set(allStatuses.flatMap((s) => metricsWithStatus(s, 'warn')))];

  if (failKeys.length === 0 && warnKeys.length === 0) {
    return '> ✅ All metrics within budget\n';
  }

  const parts = [];
  if (failKeys.length > 0) parts.push(`❌ ${failKeys.join(', ')} failed`);
  if (warnKeys.length > 0) parts.push(`⚠️ ${warnKeys.join(', ')} warning`);
  return `> ${parts.join(' · ')}\n`;
}

// Renders one form-factor section: heading + per-metric comparison table
// (reference vs. PR, with delta and a pass/warn/fail/improvement icon).
function renderSection(formFactor, prScore, refScore, budget, refLabel = 'main') {
  const { icon, label } = FORM_FACTOR_LABELS[formFactor];

  if (prScore == null) {
    return `### ${icon} ${label}\n\n_Lighthouse audit failed — no results to report._\n`;
  }

  const pr = roundScore(prScore);
  const ref = roundScore(refScore);
  const statuses = evaluateStatuses(pr, budget);

  const rows = METRICS.map((metric) => {
    const prVal = pr[metric.key];
    const refVal = ref?.[metric.key] ?? null;
    const delta = ref != null ? prVal - refVal : null;

    const deltaCell = delta != null ? formatDelta(metric, delta) : '—';
    const iconCell = STATUS_ICON[statuses[metric.key]];

    return `| ${metric.label} | ${formatRef(metric, refVal)} | ${formatValue(metric, prVal)} | ${deltaCell} | ${iconCell} |`;
  });

  const table = [`| Metric | ${refLabel} | PR | Δ | |`, '|---|---|---|---|---|', ...rows].join('\n');

  return `### ${icon} ${label}\n\n${table}\n`;
}

// Builds the PR comment body: a header line plus one comparison table per form
// factor (mobile + desktop). scores has the shape { mobile: { pr, ref }, desktop: { pr, ref } }.
// refLabel overrides the reference column header (default 'main', use 'budgets' when comparing against budgets).
export function formatComment(scores, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {}, refLabel = 'main' } = {}) {
  const headerLine = headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source} detected automatically`
    : `🔗 URL: ${previewUrl}`;

  const hasAnyRef = scores.mobile?.ref != null || scores.desktop?.ref != null;
  const note = !hasAnyRef && Object.keys(budget).length === 0
    ? '\n_No reference score for main yet — diff will appear once a PR is merged to main._\n'
    : '';

  const sections = [
    renderSection('mobile',  scores.mobile?.pr  ?? null, scores.mobile?.ref  ?? null, budget, refLabel),
    renderSection('desktop', scores.desktop?.pr ?? null, scores.desktop?.ref ?? null, budget, refLabel),
  ].join('\n');

  const verdict = computeVerdict(scores, budget);

  return `## Kanso | Performance Report

${headerLine}
${verdict}
${note}
${sections}`;
}
