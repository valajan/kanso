import { METRICS, roundScore } from '../metrics/registry.js';
import { evaluateStatuses } from '../metrics/status.js';

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

// Renders one form-factor section: heading + per-metric comparison table
// (main reference vs. PR, with delta and a pass/warn/fail/improvement icon).
function renderSection(formFactor, prScore, refScore, budget) {
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
    const improved = delta != null && (metric.lowerIsBetter ? delta < 0 : delta > 0);
    const iconCell = improved ? '🎉' : STATUS_ICON[statuses[metric.key]];

    return `| ${metric.label} | ${formatRef(metric, refVal)} | ${formatValue(metric, prVal)} | ${deltaCell} | ${iconCell} |`;
  });

  const table = ['| Metric | main | PR | Δ | |', '|---|---|---|---|---|', ...rows].join('\n');

  return `### ${icon} ${label}\n\n${table}\n`;
}

// Builds the PR comment body: a header line plus one comparison table per form
// factor (mobile + desktop). scores has the shape { mobile: { pr, ref }, desktop: { pr, ref } }.
export function formatComment(scores, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {} } = {}) {
  const headerLine = headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source} detected automatically`
    : `🔗 URL: ${previewUrl}`;

  const hasAnyRef = scores.mobile?.ref != null || scores.desktop?.ref != null;
  const note = !hasAnyRef && Object.keys(budget).length === 0
    ? '\n_No reference score for main yet — diff will appear once a PR is merged to main._\n'
    : '';

  const sections = [
    renderSection('mobile',  scores.mobile?.pr  ?? null, scores.mobile?.ref  ?? null, budget),
    renderSection('desktop', scores.desktop?.pr ?? null, scores.desktop?.ref ?? null, budget),
  ].join('\n');

  return `## Kanso | Performance Report

${headerLine}
${note}
${sections}`;
}
