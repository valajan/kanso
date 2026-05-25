const SECTION_HEADER = '## 🤖 AI Analysis';
const MARKER_START = '<!-- kanso-ai-analysis -->';
const MARKER_END = '<!-- /kanso-ai-analysis -->';

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
// - HTML tags outside code blocks, which GitHub renders and could be used for clickjacking
// We preserve content inside fenced code blocks (``` ... ```) so that suggestion
// blocks containing SVG, template HTML, or other markup are posted intact.
function sanitizeModelOutput(text) {
  const FENCE = /^```[\s\S]*?^```/gm;
  const fences = [];
  const placeholder = text.replace(FENCE, (match) => {
    fences.push(match);
    return `\x00FENCE${fences.length - 1}\x00`;
  });
  const sanitized = placeholder
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  return sanitized.replace(/\x00FENCE(\d+)\x00/g, (_, i) => fences[Number(i)]);
}

export function sanitize(text) {
  return sanitizeModelOutput(text);
}

// Renders the validated {summary, comments} structure as a markdown section.
// Inline findings are posted via the GitHub Reviews API on the relevant lines,
// so the section body only carries the overall summary plus a pointer note.
export function formatStructuredAnalysis({ summary, comments }) {
  const parts = [summary.trim()];
  if (comments.length > 0) {
    const noun = comments.length === 1 ? 'comment' : 'comments';
    parts.push(`---\n> 💬 ${comments.length} inline ${noun} posted — check the **Files changed** tab for annotated fix suggestions.`);
  }
  return wrap(parts.join('\n\n'));
}

export function formatSkippedNote(reason) {
  return wrap(`_Analysis unavailable: ${reason}._`);
}

export function metricLabels(metrics) {
  return metrics.map((m) => METRIC_LABELS[m] ?? m).join(', ');
}

export function formatPendingNote(metrics) {
  const unique = [...new Set(metrics)];
  return wrap(`_Regression detected for metrics: **${metricLabels(unique)}**. Agent analysis in progress…_`);
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
