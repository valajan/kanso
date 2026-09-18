import { elementHint, explanationLine, sharedExplanation } from '../modules/accessibility/findings.js';
import { MODULES } from '../modules/index.js';
import { METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses, metricsWithStatus } from '../modules/performance/status.js';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

// The report covers whatever modules ran, so it is named after none of them.
export const REPORT_TITLE = 'Kanso | Audit Report';

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
  return `${REPORT_MARKER}\n## ${REPORT_TITLE}\n\n⏳ ${line}${target}`;
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

// Computes an overall verdict summary: the metrics across both form factors,
// then what the modules reporting findings made of the page.
function computeVerdict(scores, budget, modules) {
  const allStatuses = [];
  for (const ff of ['mobile', 'desktop']) {
    const pr = scores[ff]?.pr;
    if (!pr) continue;
    const rounded = roundScore(pr);
    const statuses = evaluateStatuses(rounded, budget);
    allStatuses.push(statuses);
  }

  const failKeys = [...new Set(allStatuses.flatMap((s) => metricsWithStatus(s, 'fail')))];
  const warnKeys = [...new Set(allStatuses.flatMap((s) => metricsWithStatus(s, 'warn')))];

  const parts = [];
  if (failKeys.length > 0) parts.push(`❌ ${failKeys.join(', ')} failed`);
  if (warnKeys.length > 0) parts.push(`⚠️ ${warnKeys.join(', ')} warning`);
  parts.push(...findingParts(modules));

  if (parts.length > 0) return `> ${parts.join(' · ')}\n`;
  return allStatuses.length > 0 || hasFindings(modules) ? '> ✅ All checks within budget\n' : '';
}

// One part per module that counted something worth a verdict, e.g.
// "❌ 2 accessibility findings".
function findingParts(modules) {
  const parts = [];
  for (const [id, result] of findingModules(modules)) {
    for (const level of ['fail', 'warn']) {
      const count = result.findings.filter((f) => f.level === level).length;
      if (count > 0) parts.push(`${STATUS_ICON[level]} ${count} ${id} finding${count === 1 ? '' : 's'}`);
    }
  }
  return parts;
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

// Builds the PR comment body: a header line, one comparison table per form
// factor (mobile + desktop), then one section per module that reports findings.
// scores has the shape { mobile: { pr, ref }, desktop: { pr, ref } }.
// refLabel overrides the reference column header (default 'main', use 'budgets' when comparing against budgets).
// `modules` is the audit's per-module results, from which the findings sections
// are built; a module that reports none contributes nothing.
// `detected` distinguishes the two triggers: the webhook path works the preview
// URL out from a provider's events, while a CI job simply tells us what it just
// deployed. Claiming detection on the second would be untrue.
export function formatComment(scores, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {}, refLabel = 'main', detected = true, modules = {} } = {}) {
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
    // Findings are compared against the reference page, whatever the metrics
    // ended up being judged against — the two can differ, since budgets alone
    // can settle performance while accessibility still needs the comparison.
    ...findingModules(modules).map(([id, result]) => renderFindings(id, result, baseRef)),
  ].join('\n');

  const verdict = computeVerdict(scores, budget, modules);

  return `${REPORT_MARKER}
## ${REPORT_TITLE}

${headerLine}
${verdict}
${note}
${sections}`;
}

// The modules that report findings, in registry order — see src/modules/index.js.
function findingModules(modules = {}) {
  return MODULES
    .map((mod) => [mod.id, modules[mod.id]])
    .filter(([, result]) => Array.isArray(result?.findings));
}

function hasFindings(modules) {
  return findingModules(modules).length > 0;
}

const MODULE_HEADINGS = {
  accessibility: { icon: '♿', label: 'Accessibility' },
};

// Failing elements listed per rule. A rule broken on forty nodes is one problem
// to fix, and the first few say where it lives.
const ELEMENTS_SHOWN = 5;

// One findings section: a row per broken rule, worst first, the failing
// elements folded into a <details>, and a line saying what it was all judged
// against — without which a reader cannot tell a clean page from a page whose
// findings were all there before the change.
function renderFindings(id, { findings, fixed = [], comparedToBaseline, failOn }, baseRef) {
  const { icon, label } = MODULE_HEADINGS[id] ?? { icon: '🔎', label: id };
  const heading = `### ${icon} ${label}`;

  if (findings.length === 0) {
    return `${heading}\n\n_No findings — nothing failed an ${label.toLowerCase()} rule._\n`;
  }

  const rows = findings.map((finding) => {
    const change = finding.state === 'worse' ? `worse (+${finding.count - finding.baselineCount})` : finding.state ?? '—';
    return `| \`${finding.rule}\` | ${finding.impact ?? '—'} | ${finding.count} | ${change} | ${STATUS_ICON[finding.level]} |`;
  });
  const table = ['| Rule | Impact | Elements | Change | |', '|---|---|---|---|---|', ...rows].join('\n');

  const elements = findings
    // A rule Lighthouse failed without naming an element has nothing to unfold.
    .filter((finding) => finding.level !== 'pass' && finding.nodes.length > 0)
    .map((finding) => {
      const shown = finding.nodes.slice(0, ELEMENTS_SHOWN);
      const shared = sharedExplanation(shown);
      return [
        `**\`${finding.rule}\`** — ${finding.title}`,
        shared ? escapeMarkdown(shared) : null,
        ...shown.map((node) => {
          const hint = elementHint(node);
          const detail = hint?.text ? ` “${escapeMarkdown(hint.text)}”` : hint?.tag ? ` ${code(hint.tag)}` : '';
          const reason = shared ? '' : explanationLine(node.explanation);
          return `- ${code(node.selector || node.snippet)}${detail}${reason ? ` — ${escapeMarkdown(reason)}` : ''}`;
        }),
        finding.count > shown.length ? `- _…and ${finding.count - shown.length} more_` : null,
      ].filter(Boolean).join('\n');
    });

  const details = elements.length > 0
    ? `\n<details><summary>Failing elements</summary>\n\n${elements.join('\n\n')}\n\n</details>\n`
    : '';

  const parts = [`failing from \`${failOn}\` up`];
  if (comparedToBaseline) {
    const inherited = findings.filter((finding) => finding.state === 'inherited').length;
    parts.push(`${inherited} already on \`${baseRef}\``, `${fixed.length} fixed`);
  }

  return `${heading}\n\n${table}\n${details}\n_${parts.join(' · ')}_\n`;
}

// axe writes plain text, and a stray `<` or `*` in it would be read as markup.
function escapeMarkdown(text) {
  return text.replace(/[\\`*_<>[\]]/g, '\\$&');
}

// Inline code that survives a backtick in what it quotes — an attribute value
// in a tag can hold one — by fencing it with one backtick more.
function code(text) {
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
