import { fetchRelevantDiff } from './diff-fetcher.js';
import { buildPrompt } from './prompt-builder.js';
import {
  formatStructuredAnalysis,
  formatSkippedNote,
  sanitize,
} from './report-formatter.js';
import { validateAnalysis } from './validator.js';

export { formatPendingNote, replaceAnalysisSection, metricLabels } from './report-formatter.js';
export { validateAnalysis } from './validator.js';

// Posts a single PR review carrying every inline finding as a line-anchored
// comment on the right side of the diff. We use event:COMMENT (not REQUEST_CHANGES
// or APPROVE) so the review is informational and never blocks merging. Failure is
// swallowed: the section in the main PR comment still goes through.
async function postInlineReview({ forge, prNumber, sha, comments, log }) {
  if (!comments || comments.length === 0) return { posted: 0 };
  try {
    await forge.postReview({ prNumber, sha, comments });
    log?.info?.({ posted: comments.length }, '[ai-analysis] inline review posted');
    return { posted: comments.length };
  } catch (err) {
    log?.warn?.(
      { err: err?.message ?? String(err), status: err?.status },
      '[ai-analysis] inline review failed (non-blocking)'
    );
    return { posted: 0, error: err?.message ?? String(err) };
  }
}

// Runs the analysis with the injected `gptClient` (src/ai-analysis/gpt-client.js).
// Returns { section, structured } where:
// - section: the markdown block to splice into the PR comment (summary only —
//   inline findings are now delivered as native review comments).
// - structured: the validated { summary, comments[] } payload, or null on skip/fail.
export async function analyzePerformanceRegression({
  forge,
  prNumber,
  sha,
  regressions,
  gptClient,
  log,
}) {
  try {
    if (!regressions || regressions.length === 0) {
      log?.info?.('[ai-analysis] no regressions to analyze');
      return null;
    }
    // The orchestrator already gates on a configured client; this guards the
    // module against being called directly without one.
    if (!gptClient) {
      log?.info?.('[ai-analysis] no AI provider configured — skipping');
      return null;
    }

    log?.info?.(
      { metrics: regressions.map((r) => r.metric), count: regressions.length },
      '[ai-analysis] running analysis on all regressed metrics'
    );

    const diff = await fetchRelevantDiff({ forge, prNumber, log });
    if (!diff) {
      log?.info?.('[ai-analysis] no relevant files in diff — skipping AI call');
      return { section: formatSkippedNote('no relevant files in the PR diff'), structured: null };
    }

    const prompt = buildPrompt({ regressions, diff });

    const rawJson = await gptClient.requestAnalysis(prompt, { log, json: true });
    log?.info?.('[ai-analysis] analysis received');

    const structured = validateAnalysis(rawJson, diff, { sanitize, log });
    log?.info?.(
      { comments: structured.comments.length },
      '[ai-analysis] structured output validated'
    );

    await postInlineReview({ forge, prNumber, sha, comments: structured.comments, log });

    return { section: formatStructuredAnalysis(structured), structured };
  } catch (err) {
    log?.warn?.({ err: err?.message ?? String(err) }, '[ai-analysis] failed (non-blocking)');
    return { section: formatSkippedNote('the AI analysis failed'), structured: null };
  }
}
