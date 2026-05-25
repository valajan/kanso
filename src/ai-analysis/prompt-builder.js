import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SKILL.md'),
  'utf8'
);

const METRIC_LABELS = {
  performance: 'Lighthouse Performance Score',
  lcp: 'Largest Contentful Paint (LCP)',
  tbt: 'Total Blocking Time (TBT)',
  cls: 'Cumulative Layout Shift (CLS)',
  fcp: 'First Contentful Paint (FCP)',
};

const METRIC_UNITS = {
  performance: '',
  lcp: 'ms',
  tbt: 'ms',
  cls: '',
  fcp: 'ms',
};

function formatValue(metric, value) {
  if (value == null) return 'N/A';
  const unit = METRIC_UNITS[metric] ?? '';
  if (metric === 'cls') return value.toFixed(2);
  if (unit === 'ms' || metric === 'performance') return `${Math.round(value)}${unit}`;
  return `${value.toFixed(1)}${unit}`;
}

function renderFile(file) {
  const anchors = file.addedLines && file.addedLines.length > 0
    ? `Anchorable lines (only these may appear in \`comments[].line\`): ${file.addedLines.join(', ')}`
    : 'No added lines — do not produce inline comments for this file.';
  return `### ${file.filename} (${file.status ?? 'modified'})
${anchors}

\`\`\`diff
${file.patch}
\`\`\``;
}

const METRIC_ANTIPATTERNS = {
  lcp: 'Never suggest lazy-loading, async-loading, or moving the LCP candidate image lower in the DOM. The LCP image must be present in the HTML and eagerly loaded — ideally with fetchpriority="high". Async/lazy loading delays browser discovery and directly worsens LCP. Be aware that background-image LCP candidates cannot use fetchpriority and require a different strategy.',
  tbt: 'Never suggest deferring or async-loading scripts that are already deferred. Focus on reducing main-thread work: splitting long tasks, removing unused JS, or replacing synchronous third-party scripts.',
  cls: 'Never suggest removing explicit dimensions. CLS fixes require stable layout: set explicit width/height on images and embeds, use CSS aspect-ratio, avoid inserting DOM above existing content.',
  fcp: 'Never suggest lazy-loading or deferring render-blocking resources that appear above the fold. FCP requires the critical path to be as short as possible. Never suggest preloading resources indiscriminately — preload contention can delay the critical path.',
  performance: 'Address the most impactful bottlenecks. Never suggest changes that trade one metric for another (e.g. eager-loading everything to fix FCP at the cost of TBT).',
};

const FORM_FACTOR_LABELS = { mobile: '📱 mobile', desktop: '💻 desktop' };

function renderRegression({ metric, formFactor, prVal, threshold, refVal, delta }) {
  const label = METRIC_LABELS[metric] ?? metric;
  const ffSuffix = formFactor ? ` — ${FORM_FACTOR_LABELS[formFactor] ?? formFactor}` : '';
  const deltaStr = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
  const antipattern = METRIC_ANTIPATTERNS[metric] ? `\n  ⚠ ${METRIC_ANTIPATTERNS[metric]}` : '';
  return `- **${label}${ffSuffix}**: PR ${formatValue(metric, prVal)} · budget ${formatValue(metric, threshold)} · main ${formatValue(metric, refVal)} · regression ${deltaStr}${antipattern}`;
}

export function buildPrompt({ regressions, diff }) {
  return TEMPLATE
    .replace('{{regressions}}', regressions.map(renderRegression).join('\n'))
    .replace('{{diff}}', diff.map(renderFile).join('\n\n'));
}
