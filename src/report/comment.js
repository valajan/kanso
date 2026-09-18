import { countLabel, elementHint, elementWhere, explanationLine, sharedExplanation } from '../modules/findings.js';
import { MODULES } from '../modules/index.js';
import { getMetric, METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses, failThreshold, metricsWithStatus } from '../modules/performance/status.js';

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

  // Named as the tables name them, not by their keys.
  const labels = (level) => [...new Set(allStatuses.flatMap((s) => metricsWithStatus(s, level)))]
    .map((key) => getMetric(key).label);
  const failed = labels('fail');
  const warned = labels('warn');

  const parts = [];
  if (failed.length > 0) parts.push(`❌ ${failed.join(', ')} failed`);
  if (warned.length > 0) parts.push(`⚠️ ${warned.join(', ')} warning`);
  parts.push(...findingParts(modules));

  if (parts.length > 0) return `> ${parts.join(' · ')}\n`;
  return allStatuses.length > 0 || hasFindings(modules) ? '> ✅ All checks within budget\n' : '';
}

// One part per module that counted something worth a verdict, e.g.
// "❌ 2 Accessibility findings".
function findingParts(modules) {
  const parts = [];
  for (const [mod, result] of findingModules(modules)) {
    for (const level of ['fail', 'warn']) {
      const count = result.findings.filter((f) => f.level === level).length;
      if (count > 0) parts.push(`${STATUS_ICON[level]} ${count} ${mod.label} finding${count === 1 ? '' : 's'}`);
    }
  }
  return parts;
}

// Renders one form-factor section: heading + per-metric comparison table
// (reference vs. PR, with delta and a pass/warn/fail/improvement icon).
//
// The icon is read against the budget, whatever the reference column holds. So
// the budget has a column of its own whenever a baseline takes the reference
// one: without it, a PR scoring what main scores can show ❌ with nothing on
// the line saying why. Against budgets alone, the reference column is the
// budget, and Δ the distance to it.
function renderSection(formFactor, prScore, refScore, budget, { refLabel = 'main', currentLabel = 'PR', referenceKind = 'baseline' } = {}) {
  const { icon, label } = FORM_FACTOR_LABELS[formFactor];

  if (prScore == null) {
    return `### ${icon} ${label}\n\n_Lighthouse audit failed — no results to report._\n`;
  }

  const againstBaseline = referenceKind === 'baseline';
  const pr = roundScore(prScore);
  const ref = roundScore(refScore);
  const statuses = evaluateStatuses(pr, budget);

  const rows = METRICS.map((metric) => {
    const threshold = failThreshold(metric, budget);
    const prVal = pr[metric.key];
    const refVal = againstBaseline ? ref?.[metric.key] ?? null : threshold;
    const delta = prVal != null && refVal != null ? prVal - refVal : null;

    const cells = [
      metric.label,
      ...(againstBaseline ? [formatValue(metric, threshold)] : []),
      formatValue(metric, refVal),
      formatValue(metric, prVal),
      delta != null ? formatDelta(metric, delta) : '—',
      STATUS_ICON[statuses[metric.key]],
    ];
    return `| ${cells.join(' | ')} |`;
  });

  // The last column holds the icon, and has no heading.
  const headings = ['Metric', ...(againstBaseline ? ['budget'] : []), refLabel, currentLabel, 'Δ'];
  const table = [`| ${headings.join(' | ')} | |`, `|${'---|'.repeat(headings.length + 1)}`, ...rows].join('\n');

  return `### ${icon} ${label}\n\n${table}\n`;
}

// Builds the PR comment body: the report, behind the marker a re-run looks for.
export function formatComment(scores, options = {}) {
  return `${REPORT_MARKER}\n${formatReport(scores, options)}`;
}

// Builds the report: a header line, one comparison table per form factor
// (mobile + desktop), then one section per module that reports findings. The PR
// comment is this behind a marker; `kanso audit --out report.md` is this alone,
// which is what a CI job summary shows.
// scores has the shape { mobile: { pr, ref }, desktop: { pr, ref } }.
// refLabel overrides the reference column header (default 'main', use 'budgets' when comparing against budgets).
// referenceKind is the performance module's: 'baseline' when the reference is a
// page, which then gets a budget column beside it; 'budgets' when the budgets
// are the reference.
// currentLabel heads the column of the page under audit: the PR's, by default.
// `header` replaces the line naming what was audited, for a report that is not
// about a pull request.
// `modules` is the audit's per-module results, from which the findings sections
// are built; a module that reports none contributes nothing.
// `detected` distinguishes the two triggers: the webhook path works the preview
// URL out from a provider's events, while a CI job simply tells us what it just
// deployed. Claiming detection on the second would be untrue.
export function formatReport(scores, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {}, refLabel = 'main', referenceKind = 'baseline', currentLabel = 'PR', header, detected = true, modules = {} } = {}) {
  const headerLine = header ?? (headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source}${detected ? ' detected automatically' : ''}`
    : `🔗 URL: ${previewUrl}`);

  const hasAnyRef = scores.mobile?.ref != null || scores.desktop?.ref != null;
  const note = !hasAnyRef && Object.keys(budget).length === 0
    ? '\n_No reference score for main yet — diff will appear once a PR is merged to main._\n'
    : '';

  const sections = [
    renderSection('mobile',  scores.mobile?.pr  ?? null, scores.mobile?.ref  ?? null, budget, { refLabel, currentLabel, referenceKind }),
    renderSection('desktop', scores.desktop?.pr ?? null, scores.desktop?.ref ?? null, budget, { refLabel, currentLabel, referenceKind }),
    // Findings are compared against the reference page, whatever the metrics
    // ended up being judged against — the two can differ, since budgets alone
    // can settle performance while accessibility still needs the comparison.
    ...findingModules(modules).map(([mod, result]) => renderFindings(mod, result, baseRef)),
  ].join('\n');

  const verdict = computeVerdict(scores, budget, modules);

  return `## ${REPORT_TITLE}

${headerLine}
${verdict}
${note}
${sections}`;
}

// The performance module's scores, { [formFactor]: { current, reference } }, in
// the shape the report reads them.
export function reportScores(scores = {}) {
  return Object.fromEntries(
    Object.entries(scores).map(([formFactor, { current, reference }]) => [formFactor, { pr: current, ref: reference }])
  );
}

// The modules that report findings, in registry order — see src/modules/index.js.
function findingModules(modules = {}) {
  return MODULES
    .map((mod) => [mod, modules[mod.id]])
    .filter(([, result]) => Array.isArray(result?.findings));
}

function hasFindings(modules) {
  return findingModules(modules).length > 0;
}

// A module with no icon of its own gets the magnifier: a new module reports
// here without this file changing.
const MODULE_ICONS = {
  accessibility: '♿',
  seo: '🔍',
  'best-practices': '🧰',
};

// Failing elements listed per rule. A rule broken on forty nodes is one problem
// to fix, and the first few say where it lives.
const ELEMENTS_SHOWN = 5;

// One findings section: a row per broken rule, worst first, where each one
// failed folded into a <details>, and a line saying what it was all judged
// against — without which a reader cannot tell a clean page from a page whose
// findings were all there before the change.
function renderFindings(mod, { findings, fixed = [], comparedToBaseline, failOn, ignore = [], probeFailures = [] }, baseRef) {
  const heading = `### ${MODULE_ICONS[mod.id] ?? '🔎'} ${mod.label}`;

  // What it was all judged against, found or not: without it, a section with
  // nothing left in it cannot say that the change fixed what was there. How
  // many findings were already there is only worth saying when there are some.
  const parts = [`failing from \`${failOn}\` up`];
  if (comparedToBaseline) {
    if (findings.length > 0) {
      const inherited = findings.filter((finding) => finding.state === 'inherited').length;
      parts.push(`${inherited} already on \`${baseRef}\``);
    }
    parts.push(`${fixed.length} fixed`);
  }
  if (ignore.length > 0) parts.push(`ignoring ${ignore.map((rule) => code(rule)).join(', ')}`);
  // A probe that did not run checked nothing, which a clean section must not
  // be read as.
  const unchecked = probeFailures.map(({ probe, rules, side, formFactor, error }) =>
    `\n_⚠️ ${code(probe)} did not run on the ${formFactor} ${side === 'current' ? 'page' : 'reference'} (${escapeMarkdown(error)}): ${rules.map((rule) => code(rule)).join(', ')} unchecked_`);
  const judged = `_${parts.join(' · ')}_${unchecked.join('')}`;

  if (findings.length === 0) {
    return `${heading}\n\n_No findings — every rule checked passed._\n\n${judged}\n`;
  }

  const rows = findings.map((finding) => {
    const change = finding.state === 'worse' ? `worse (+${finding.count - finding.baselineCount})` : finding.state ?? '—';
    return `| \`${finding.rule}\` | ${finding.impact ?? '—'} | ${countLabel(finding)} | ${change} | ${STATUS_ICON[finding.level]} |`;
  });
  const table = ['| Rule | Impact | Found | Change | |', '|---|---|---|---|---|', ...rows].join('\n');

  const explained = findings
    // A rule that failed as a whole, with nothing to say beyond its title, has
    // nothing to unfold.
    .filter((finding) => finding.level !== 'pass' && (finding.nodes.length > 0 || finding.detail))
    .map((finding) => {
      const shown = finding.nodes.slice(0, ELEMENTS_SHOWN);
      const shared = sharedExplanation(shown);
      return [
        `**\`${finding.rule}\`** — ${finding.title}`,
        finding.detail ? escapeMarkdown(finding.detail) : null,
        shared ? escapeMarkdown(shared) : null,
        ...shown.map((node) => {
          const where = elementWhere(node);
          const reason = shared ? '' : explanationLine(node.explanation);
          // A tag the page lacks is nowhere: its explanation is all there is.
          if (!where) return reason ? `- ${escapeMarkdown(reason)}` : null;
          const hint = elementHint(node);
          const detail = hint?.text ? ` “${escapeMarkdown(hint.text)}”` : hint?.tag ? ` ${code(hint.tag)}` : '';
          return `- ${code(where)}${detail}${reason ? ` — ${escapeMarkdown(reason)}` : ''}`;
        }),
        finding.count > shown.length ? `- _…and ${finding.count - shown.length} more_` : null,
      ].filter(Boolean).join('\n');
    });

  const details = explained.length > 0
    ? `\n<details><summary>What failed, and where</summary>\n\n${explained.join('\n\n')}\n\n</details>\n`
    : '';

  return `${heading}\n\n${table}\n${details}\n${judged}\n`;
}

// axe writes plain text, and a stray `<` or `*` in it would be read as markup.
function escapeMarkdown(text) {
  return text.replace(/[\\`*_<>[\]]/g, '\\$&');
}

// Inline code that survives a backtick in what it quotes — an attribute value
// in a tag can hold one — by fencing it with one backtick more.
export function code(text) {
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
