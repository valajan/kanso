import { moduleConfig } from '../config/module-config.js';
import { countLabel, elementHint, elementWhere, explanationLine, sharedExplanation } from '../modules/findings.js';
import { checkLabel, MODULES } from '../modules/index.js';
import { getMetric, METRICS, roundScore } from '../modules/performance/metrics.js';
import { evaluateStatuses, failThreshold, metricsWithStatus } from '../modules/performance/status.js';
import { siteName } from '../serve/index.js';

// The audit as Markdown: what `--out report.md` writes, and what a CI job
// summary shows. `render.js` is the same audit for a terminal.
//
// The report covers whatever modules ran, so it is named after none of them.
// The GitHub Action hardcodes this title for the case where no report was
// written at all — keep the two in step.
const REPORT_TITLE = 'Kanso | Audit Report';

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

const FORM_FACTOR_LABELS = {
  mobile:  { icon: '📱', label: 'Mobile' },
  desktop: { icon: '💻', label: 'Desktop' },
};

export function renderMarkdown({ url, baseline, served = null, result, config = {} }) {
  if (!result.ok) return `## ${REPORT_TITLE}\n\n⚠️ The audit could not run: ${code(result.error)}\n`;

  const perf = result.modules.performance;
  const page = code(siteName(url, served?.url));
  const header = baseline ? `🔗 ${page} against ${code(siteName(baseline, served?.baseline))}` : `🔗 ${page}`;

  return formatReport(perf?.scores ?? {}, {
    header,
    budget: moduleConfig(config, 'performance').budgets ?? {},
    referenceKind: perf?.referenceKind,
    referenceLabel: perf?.referenceKind === 'budgets' ? 'budget' : 'baseline',
    modules: result.modules,
    diagnostics: perf?.diagnostics ?? {},
  });
}

// Builds the report: a header line, one comparison table per form factor
// (mobile + desktop), then one section per module that reports findings.
//
// `scores` is the performance module's own shape,
// { [formFactor]: { current, reference } }.
// `header` names what was audited.
// `referenceKind` is the performance module's: 'baseline' when the reference is
// a page, which then gets a budget column beside it; 'budgets' when the budgets
// are the reference.
// `referenceLabel` heads the reference column, and names what a finding the page
// already carried was inherited from.
// `modules` is the audit's per-module results, from which the findings sections
// are built; a module that reports none contributes nothing.
// `diagnostics` is the performance module's, of which the report says only
// why INP is missing part of its clicks, when it is. Why it is missing
// altogether is the performance module's `skipped`, said as every module's is.
//
// Exported for the tests, which are the only other caller.
export function formatReport(scores, { header, budget = {}, referenceKind = 'baseline', referenceLabel = 'baseline', modules = {}, diagnostics = {} } = {}) {
  const sections = [
    renderSection('mobile', scores.mobile, budget, { referenceLabel, referenceKind, inp: diagnostics.mobile?.current?.inp }),
    renderSection('desktop', scores.desktop, budget, { referenceLabel, referenceKind, inp: diagnostics.desktop?.current?.inp }),
    ...(Object.keys(scores).length > 0 && modules.performance?.skipped?.length > 0
      ? [`${skippedLine('performance', modules.performance.skipped)}\n`]
      : []),
    // Findings are compared against the reference page, whatever the metrics
    // ended up being judged against — the two can differ, since budgets alone
    // can settle performance while accessibility still needs the comparison.
    ...findingModules(modules).map(([mod, result]) => renderFindings(mod, result, referenceLabel)),
  ].join('\n');

  // The blank line after the verdict is the one the report has always had.
  return `## ${REPORT_TITLE}

${header}
${computeVerdict(scores, budget, modules)}

${sections}`;
}

// Renders one form-factor section: heading + per-metric comparison table
// (reference vs. current, with delta and a pass/warn/fail icon).
//
// The icon is read against the budget, whatever the reference column holds. So
// the budget has a column of its own whenever a baseline takes the reference
// one: without it, a page scoring what its baseline scores can show ❌ with
// nothing on the line saying why. Against budgets alone, the reference column
// is the budget, and Δ the distance to it.
function renderSection(formFactor, sides, budget, { referenceLabel, referenceKind, inp = null }) {
  const { icon, label } = FORM_FACTOR_LABELS[formFactor];
  const currentScore = sides?.current ?? null;

  if (currentScore == null) {
    return `### ${icon} ${label}\n\n_Lighthouse audit failed — no results to report._\n`;
  }

  const againstBaseline = referenceKind === 'baseline';
  const current = roundScore(currentScore);
  const reference = roundScore(sides?.reference ?? null);
  const statuses = evaluateStatuses(current, budget);

  const rows = METRICS.map((metric) => {
    const threshold = failThreshold(metric, budget);
    const currentVal = current[metric.key];
    const referenceVal = againstBaseline ? reference?.[metric.key] ?? null : threshold;
    const delta = currentVal != null && referenceVal != null ? currentVal - referenceVal : null;

    const cells = [
      metric.label,
      ...(againstBaseline ? [formatValue(metric, threshold)] : []),
      formatValue(metric, referenceVal),
      formatValue(metric, currentVal),
      delta != null ? formatDelta(metric, delta) : '—',
      // No icon for a metric nobody measured: INP with nothing clicked.
      STATUS_ICON[statuses[metric.key]] ?? '',
    ];
    return `| ${cells.join(' | ')} |`;
  });

  // The last column holds the icon, and has no heading.
  const headings = ['Metric', ...(againstBaseline ? ['budget'] : []), referenceLabel, 'current', 'Δ'];
  const table = [`| ${headings.join(' | ')} | |`, `|${'---|'.repeat(headings.length + 1)}`, ...rows].join('\n');

  // A state not reached leaves its click out of the INP: said, so that an INP
  // missing it is not read as the page's.
  // Kept apart from the table by a blank line, or GFM reads it as a row.
  const unreached = (inp?.failures ?? []).map(({ at, error }) => (at
    ? `_⚠️ ${code(at)} could not be reached (${error}): its click is not in the INP_`
    : `_⚠️ INP not measured (${error})_`)).join('\n');

  return `### ${icon} ${label}\n\n${table}\n${unreached ? `\n${unreached}\n` : ''}`;
}

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
  for (const formFactor of ['mobile', 'desktop']) {
    const current = scores[formFactor]?.current;
    if (!current) continue;
    allStatuses.push(evaluateStatuses(roundScore(current), budget));
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

// Rules named one by one when a check could not run, before they are counted.
const RULES_NAMED = 6;

// One findings section: a row per broken rule, worst first, where each one
// failed folded into a <details>, and a line saying what it was all judged
// against — without which a reader cannot tell a clean page from a page whose
// findings were all there before the change.
function renderFindings(mod, { findings, fixed = [], comparedToBaseline, failOn, ignore = [], probeFailures = [], skipped = [] }, referenceLabel) {
  const heading = `### ${MODULE_ICONS[mod.id] ?? '🔎'} ${mod.label}`;

  // What it was all judged against, found or not: without it, a section with
  // nothing left in it cannot say that the change fixed what was there. How
  // many findings were already there is only worth saying when there are some.
  const parts = [`failing from \`${failOn}\` up`];
  if (comparedToBaseline) {
    if (findings.length > 0) {
      const inherited = findings.filter((finding) => finding.state === 'inherited').length;
      parts.push(`${inherited} already on \`${referenceLabel}\``);
    }
    parts.push(`${fixed.length} fixed`);
  }
  if (ignore.length > 0) parts.push(`ignoring ${ignore.map((rule) => code(rule)).join(', ')}`);
  // A probe that did not run checked nothing, which a clean section must not
  // be read as.
  // A state that could not be reached is said as such: the check ran, on
  // everything but that part of the page.
  const unchecked = probeFailures.map(({ probe, rules, side, formFactor, error, at }) => {
    const where = `the ${formFactor} ${side === 'current' ? 'page' : 'reference'} (${escapeMarkdown(error)})`;
    return at
      ? `\n_⚠️ ${code(at)} could not be reached on ${where}: ${rulesLabel(rules)} unchecked there_`
      : `\n_⚠️ ${code(probe)} did not run on ${where}: ${rulesLabel(rules)} unchecked_`;
  });
  // A probe left out for want of a state is neither: nothing went wrong, and
  // nothing was checked.
  const notRun = skipped.length > 0 ? `\n${skippedLine(mod.id, skipped)}` : '';
  const judged = `_${parts.join(' · ')}_${unchecked.join('')}${notRun}`;

  if (findings.length === 0) {
    return `${heading}\n\n_No findings — every rule checked passed._\n\n${judged}\n`;
  }

  const rows = findings.map((finding) => {
    const change = finding.state === 'worse' ? `worse (+${finding.count - finding.baselineCount})` : finding.state ?? '—';
    // A rule axe could not settle is not a rule the page breaks, and the
    // table must not read as if it were.
    const rule = code(finding.rule) + atLabel(finding) + (finding.needsReview ? ' _(needs review)_' : '');
    return `| ${rule} | ${finding.impact ?? '—'} | ${countLabel(finding)} | ${change} | ${STATUS_ICON[finding.level]} |`;
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
        `**\`${finding.rule}\`**${atLabel(finding)} — ${finding.needsReview ? `needs review: ${finding.title}` : finding.title}`,
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

// Where on the page a rule was broken, when it was not on the page as it
// loads: the declared state it was found in.
function atLabel({ at }) {
  return at ? ` @ ${code(at)}` : '';
}

// The probes of a module that did not run, the project declaring no state for
// them to open or click, and the rules nobody checked for it — with the way
// to declare some.
function skippedLine(moduleId, skipped) {
  const probes = skipped.map(({ probe }) => code(probe)).join(', ');
  const rules = skipped.flatMap((skip) => skip.rules.map((rule) => checkLabel(moduleId, rule)));
  return `_⏭️ ${probes} skipped: no \`states:\` declared in \`.kanso.yml\`, so nothing was opened or clicked: `
    + `${rulesLabel(rules)} not checked. \`kanso discover --write\` finds them._`;
}

// A handful of rules by name; axe's hundred by number.
function rulesLabel(rules) {
  return rules.length > RULES_NAMED ? `${rules.length} rules` : rules.map((rule) => code(rule)).join(', ');
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
