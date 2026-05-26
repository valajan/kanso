import { fetchRelevantDiff } from './diff-fetcher.js';
import { buildPrompt } from './prompt-builder.js';
import { requestAnalysis } from './gpt-client.js';
import {
  formatStructuredAnalysis,
  formatSkippedNote,
  sanitize,
} from './report-formatter.js';
import { validateAnalysis } from './validator.js';

export { formatPendingNote, replaceAnalysisSection, metricLabels } from './report-formatter.js';
export { validateAnalysis } from './validator.js';

const SIGNIFICANT_DEGRADATION_PCT = 10;
const HIGHER_IS_BETTER = new Set(['performance']);

function normalize(metric, value) {
  if (value == null) return null;
  return metric === 'tbt' ? Math.round(value) : value;
}

function degradationPct(metric, prValue, refValue) {
  if (refValue == null) return null;
  if (refValue === 0) return prValue > 0 ? Infinity : 0;
  return HIGHER_IS_BETTER.has(metric)
    ? ((refValue - prValue) / refValue) * 100
    : ((prValue - refValue) / refValue) * 100;
}

export function detectSignificantRegressions({ statuses, prScore, refScore, budget, formFactor, isBudgetRef = false }) {
  const failed = Object.entries(statuses)
    .filter(([, s]) => s === 'fail')
    .map(([k]) => k);

  const out = [];
  for (const metric of failed) {
    const prVal = normalize(metric, prScore[metric]);
    const refVal = refScore == null ? null : normalize(metric, refScore[metric]);
    const delta = degradationPct(metric, prVal, refVal);
    // When comparing against budget thresholds (no prod), any fail warrants analysis.
    // When comparing against live prod, require >10% degradation to avoid noise.
    if (!isBudgetRef && (delta == null || delta <= SIGNIFICANT_DEGRADATION_PCT)) continue;
    out.push({ metric, formFactor, prVal, refVal, delta, threshold: budget?.[metric] ?? null });
  }
  return out.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));
}

// Posts a single PR review carrying every inline finding as a line-anchored
// comment on the right side of the diff. We use event:COMMENT (not REQUEST_CHANGES
// or APPROVE) so the review is informational and never blocks merging. Failure is
// swallowed: the section in the main PR comment still goes through.
async function postInlineReview({ octokit, owner, repo, prNumber, sha, comments, log }) {
  if (!comments || comments.length === 0) return { posted: 0 };
  try {
    await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
      owner,
      repo,
      pull_number: prNumber,
      ...(sha ? { commit_id: sha } : {}),
      event: 'COMMENT',
      comments: comments.map((c) => ({
        path: c.file,
        line: c.line,
        side: 'RIGHT',
        body: c.body,
        ...(c.startLine != null ? { start_line: c.startLine, start_side: 'RIGHT' } : {}),
      })),
    });
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

// Returns { section, structured } where:
// - section: the markdown block to splice into the PR comment (summary only —
//   inline findings are now delivered as native review comments).
// - structured: the validated { summary, comments[] } payload, or null on skip/fail.
export async function analyzePerformanceRegression({
  octokit,
  owner,
  repo,
  prNumber,
  sha,
  regressions,
  log,
}) {
  try {
    if (!regressions || regressions.length === 0) {
      log?.info?.('[ai-analysis] no regressions to analyze');
      return null;
    }

    log?.info?.(
      { metrics: regressions.map((r) => r.metric), count: regressions.length },
      '[ai-analysis] running analysis on all regressed metrics'
    );

    const diff = await fetchRelevantDiff({ octokit, owner, repo, prNumber, log });
    if (!diff) {
      log?.info?.('[ai-analysis] no relevant files in diff — skipping AI call');
      return { section: formatSkippedNote('no relevant files in the PR diff'), structured: null };
    }

    const prompt = buildPrompt({ regressions, diff });

    const rawJson = await requestAnalysis(prompt, { log, json: true });
    log?.info?.('[ai-analysis] analysis received');

    const structured = validateAnalysis(rawJson, diff, { sanitize, log });
    log?.info?.(
      { comments: structured.comments.length },
      '[ai-analysis] structured output validated'
    );

    await postInlineReview({
      octokit, owner, repo, prNumber, sha,
      comments: structured.comments,
      log,
    });

    return { section: formatStructuredAnalysis(structured), structured };
  } catch (err) {
    log?.warn?.({ err: err?.message ?? String(err) }, '[ai-analysis] failed (non-blocking)');
    return { section: formatSkippedNote('the AI analysis failed'), structured: null };
  }
}
