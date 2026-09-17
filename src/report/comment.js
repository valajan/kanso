import { METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses, metricsWithStatus } from '../modules/performance/status.js';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

// Hidden marker embedded in every Kanso report comment. It is how a re-run
// finds the comment it wrote last time and edits it in place, instead of
// stacking a new report on every push. Being carried in the comment body makes
// that lookup stateless: it survives a restart, and works on any instance.
export const REPORT_MARKER = '<!-- kanso:report -->';

// The comment posted before the audit starts. On the /v1/audit path, writing it
// is also how the caller's permission to comment on the PR is proven, so it goes
// out before any Lighthouse run is scheduled.
export function formatPlaceholder({ previewUrl, source = 'preview', message } = {}) {
  const line = message ?? `Auditing the ${source} deployment…`;
  const target = previewUrl ? `\n\n🔗 ${previewUrl}` : '';
  return `${REPORT_MARKER}\n## Kanso | Performance Report\n\n⏳ ${line}${target}`;
}

const FORM_FACTOR_LABELS = {
  mobile:  { icon: '📱', label: 'Mobile' },
  desktop: { icon: '💻', label: 'Desktop' },
};

function formatValue(metric, value) {
  if (value == null) return '—';
  return value.toFixed(metric.decimals) + metric.unit;
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
    const delta = prVal != null && refVal != null ? prVal - refVal : null;

    const deltaCell = delta != null ? formatDelta(metric, delta) : '—';
    const iconCell = STATUS_ICON[statuses[metric.key]];

    return `| ${metric.label} | ${formatValue(metric, refVal)} | ${formatValue(metric, prVal)} | ${deltaCell} | ${iconCell} |`;
  });

  const table = [`| Metric | ${refLabel} | PR | Δ | |`, '|---|---|---|---|---|', ...rows].join('\n');

  return `### ${icon} ${label}\n\n${table}\n`;
}

// Builds the PR comment body: a header line plus one comparison table per form
// factor (mobile + desktop). scores has the shape { mobile: { pr, ref }, desktop: { pr, ref } }.
// refLabel overrides the reference column header (default 'main', use 'budgets' when comparing against budgets).
// `detected` distinguishes the two triggers: the webhook path works the preview
// URL out from a provider's events, while a CI job simply tells us what it just
// deployed. Claiming detection on the second would be untrue.
export function formatComment(scores, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {}, refLabel = 'main', detected = true } = {}) {
  const headerLine = headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source}${detected ? ' detected automatically' : ''}`
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

  return `${REPORT_MARKER}
## Kanso | Performance Report

${headerLine}
${verdict}
${note}
${sections}`;
}
