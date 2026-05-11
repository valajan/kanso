const SECTION_HEADER = '## 🤖 AI Analysis';
const MARKER_START = '<!-- perfguard-ai-analysis -->';
const MARKER_END = '<!-- /perfguard-ai-analysis -->';

const METRIC_LABELS = {
  performance: 'Performance',
  lcp: 'LCP',
  tbt: 'TBT',
  cls: 'CLS',
  fcp: 'FCP',
};

function wrap(content) {
  return `\n${MARKER_START}\n${SECTION_HEADER}\n\n${content}\n${MARKER_END}\n`;
}

// The model output is posted to GitHub by the bot, so we must neutralize:
// - our own section markers, to keep replaceAnalysisSection idempotent
// - HTML tags, which GitHub renders in comments and could be used for clickjacking
function sanitizeModelOutput(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
}

export function formatAnalysis(analysis) {
  return wrap(sanitizeModelOutput(analysis).trim());
}

export function formatSkippedNote(reason) {
  return wrap(`_Analysis unavailable: ${reason}._`);
}

export function metricLabels(metrics) {
  return metrics.map((m) => METRIC_LABELS[m] ?? m).join(', ');
}

export function formatPendingNote(metrics) {
  return wrap(`_Regression detected for metrics: **${metricLabels(metrics)}**. Agent analysis in progress…_`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceAnalysisSection(body, newSection) {
  const re = new RegExp(
    `\\n?${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}\\n?`
  );
  if (re.test(body)) return body.replace(re, newSection);
  return body + newSection;
}
