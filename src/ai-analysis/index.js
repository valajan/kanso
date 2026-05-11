import { fetchRelevantDiff } from './diff-fetcher.js';
import { buildPrompt } from './prompt-builder.js';
import { requestAnalysis } from './gpt-client.js';
import { formatAnalysis, formatSkippedNote } from './report-formatter.js';

export { formatPendingNote, replaceAnalysisSection, metricLabels } from './report-formatter.js';

const SIGNIFICANT_DEGRADATION_PCT = 10;
const HIGHER_IS_BETTER = new Set(['performance']);

function normalize(metric, value) {
  if (value == null) return null;
  return metric === 'tbt' ? Math.round(value) : value;
}

function degradationPct(metric, prValue, refValue) {
  if (refValue == null || refValue === 0) return null;
  return HIGHER_IS_BETTER.has(metric)
    ? ((refValue - prValue) / refValue) * 100
    : ((prValue - refValue) / refValue) * 100;
}

export function detectSignificantRegressions({ statuses, prScore, refScore, budget }) {
  const failed = Object.entries(statuses)
    .filter(([, s]) => s === 'fail')
    .map(([k]) => k);

  const out = [];
  for (const metric of failed) {
    const prVal = normalize(metric, prScore[metric]);
    const refVal = refScore == null ? null : normalize(metric, refScore[metric]);
    const delta = degradationPct(metric, prVal, refVal);
    if (delta == null || delta <= SIGNIFICANT_DEGRADATION_PCT) continue;
    out.push({ metric, prVal, refVal, delta, threshold: budget?.[metric] ?? null });
  }
  return out.sort((a, b) => b.delta - a.delta);
}

export async function analyzePerformanceRegression({
  octokit,
  owner,
  repo,
  prNumber,
  regressions,
  log,
}) {
  try {
    if (!regressions || regressions.length === 0) {
      log?.info?.('[ai-analysis] no regressions to analyze');
      return null;
    }

    const worst = regressions[0];
    log?.info?.(
      { metric: worst.metric, delta: worst.delta.toFixed(1) + '%' },
      '[ai-analysis] running analysis on worst metric'
    );

    const diff = await fetchRelevantDiff({ octokit, owner, repo, prNumber, log });
    if (!diff) {
      log?.info?.('[ai-analysis] no relevant files in diff — skipping AI call');
      return formatSkippedNote('no relevant files in the PR diff');
    }

    const prompt = buildPrompt({
      metric: worst.metric,
      currentValue: worst.prVal,
      threshold: worst.threshold,
      refValue: worst.refVal,
      delta: worst.delta,
      diff,
    });

    const analysis = await requestAnalysis(prompt, { log });
    log?.info?.('[ai-analysis] analysis received');
    return formatAnalysis(analysis);
  } catch (err) {
    log?.warn?.({ err: err?.message ?? String(err) }, '[ai-analysis] failed (non-blocking)');
    return formatSkippedNote('the AI analysis failed');
  }
}
