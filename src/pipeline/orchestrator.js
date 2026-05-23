import { loadRepoConfig } from '../config/repo-config.js';
import { roundScore } from '../metrics/registry.js';
import { evaluateStatuses, hasStatus } from '../metrics/status.js';
import { formatComment } from '../report/comment.js';
import { commitStatusPayload } from '../report/commit-status.js';
import {
  analyzePerformanceRegression,
  detectSignificantRegressions,
  formatPendingNote,
  replaceAnalysisSection,
} from '../ai-analysis/index.js';

const FORM_FACTORS = ['mobile', 'desktop'];

// Builds the report pipeline. External dependencies are injected so the
// pipeline can be exercised in isolation:
// - store:         PreviewStore coordinating webhook state
// - staticConfig:  parsed config.yml, the base for per-repo config merges
// - runLighthouse: the audit runner (one URL → metrics), accepts { formFactor }
export function createOrchestrator({ store, staticConfig, runLighthouse }) {
  // Posts the report, reusing the "waiting for preview" placeholder comment if
  // one was left for this PR; otherwise creates a fresh comment.
  async function postOrEditComment({ octokit, owner, repo, prNumber, body }) {
    const waitingCommentId = store.takeWaitingComment(prNumber);
    if (waitingCommentId != null) {
      await octokit.request(
        'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
        { owner, repo, comment_id: waitingCommentId, body }
      );
      return waitingCommentId;
    }
    const { data } = await octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner, repo, issue_number: prNumber, body }
    );
    return data.id;
  }

  // Audits the PR preview and the production reference (mobile + desktop, all in
  // parallel — each audit runs in its own worker thread for perf-hooks isolation),
  // posts the report comment and commit status, and triggers AI analysis on a
  // real regression.
  async function runAndPostReport({ octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, source, log, repoConfig }) {
    const budget = repoConfig.budgets ?? {};
    const aiAnalysisEnabled = repoConfig.ai_analysis === true;
    const baseUrl = repoConfig.base_url;

    log.info(`PR #${prNumber} — Lighthouse auditing preview & prod (mobile + desktop) in parallel...`);
    const [previewMobile, previewDesktop, refMobile, refDesktop] = await Promise.allSettled([
      runLighthouse(previewUrl, { formFactor: 'mobile' }),
      runLighthouse(previewUrl, { formFactor: 'desktop' }),
      runLighthouse(baseUrl,    { formFactor: 'mobile' }),
      runLighthouse(baseUrl,    { formFactor: 'desktop' }),
    ]);

    // If both preview audits fail, we have nothing meaningful to report.
    if (previewMobile.status === 'rejected' && previewDesktop.status === 'rejected') {
      const msg = previewMobile.reason?.message ?? 'unknown error';
      log.error(`PR #${prNumber} — Lighthouse failed on preview (mobile + desktop): ${msg}`);
      await postOrEditComment({
        octokit, owner, repo, prNumber,
        body: `⚠️ Kanso — Lighthouse analysis failed: \`${msg}\``,
      });
      return { ok: false, error: msg };
    }

    const scores = {
      mobile: {
        pr:  previewMobile.status === 'fulfilled' ? previewMobile.value : null,
        ref: refMobile.status     === 'fulfilled' ? refMobile.value     : null,
      },
      desktop: {
        pr:  previewDesktop.status === 'fulfilled' ? previewDesktop.value : null,
        ref: refDesktop.status     === 'fulfilled' ? refDesktop.value     : null,
      },
    };

    // Surface soft failures (one form factor or the prod reference) without aborting.
    const softFailures = [
      ['mobile preview',  previewMobile],
      ['desktop preview', previewDesktop],
      ['mobile prod',     refMobile],
      ['desktop prod',    refDesktop],
    ];
    for (const [label, settled] of softFailures) {
      if (settled.status === 'rejected') {
        log.warn(`PR #${prNumber} — Lighthouse failed on ${label}: ${settled.reason.message}`);
      }
    }

    // Per-form-factor statuses + union of significant regressions.
    const statusesByForm = {};
    const regressions = [];
    for (const formFactor of FORM_FACTORS) {
      const prScore = scores[formFactor].pr;
      if (!prScore) continue;
      const statuses = evaluateStatuses(roundScore(prScore), budget);
      statusesByForm[formFactor] = statuses;
      regressions.push(...detectSignificantRegressions({
        statuses,
        prScore,
        refScore: scores[formFactor].ref,
        budget,
        formFactor,
      }));
    }

    // Global commit status: worst-of per metric across form factors (fail > warn > pass).
    const combinedStatuses = combineStatuses(statusesByForm);

    const baseBody = formatComment(scores, {
      previewUrl, headRef, baseRef, source, budget,
    });

    const initialBody = aiAnalysisEnabled && regressions.length > 0
      ? baseBody + formatPendingNote(regressions.map((r) => r.metric))
      : baseBody;

    const commentId = await postOrEditComment({ octokit, owner, repo, prNumber, body: initialBody });

    if (sha) {
      const { state, description } = commitStatusPayload(combinedStatuses);
      await octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
        owner, repo, sha, state, description, context: 'kanso',
      }).catch((err) => log.warn(`PR #${prNumber} — failed to post commit status: ${err.message}`));
    }

    if (aiAnalysisEnabled && regressions.length > 0) {
      analyzePerformanceRegression({ octokit, owner, repo, prNumber, sha, regressions, log })
        .then(async (result) => {
          if (!result?.section) return;
          const updatedBody = replaceAnalysisSection(initialBody, result.section);
          await octokit.request(
            'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
            { owner, repo, comment_id: commentId, body: updatedBody }
          );
          const n = result.structured?.comments?.length ?? 0;
          log.info(`PR #${prNumber} — AI analysis posted (${n} inline comment${n !== 1 ? 's' : ''})`);
        })
        .catch((err) => log.warn(`PR #${prNumber} — AI analysis failed: ${err.message}`));
    }

    const icon = hasStatus(combinedStatuses, 'fail') ? '❌' : hasStatus(combinedStatuses, 'warn') ? '⚠️' : '✅';
    log.info(`PR #${prNumber} ${icon} report posted — ${summarizePerf(scores)}`);
    return { ok: true, scores };
  }

  // Handles a preview-ready provider event: maps the deployment SHA to its open
  // PR, records the preview URL, and — if the PR was parked waiting for this
  // deployment — waits for assets to stabilize and runs the report.
  async function handlePreviewUrl({ octokit, owner, repo, sha, targetUrl, source, log }) {
    const { data: prs } = await octokit.request(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      { owner, repo, commit_sha: sha }
    );
    const pr = prs.find((p) => p.state === 'open');
    if (!pr) return { ok: true, ignored: 'no open PR for sha' };

    // A late-arriving status event for a superseded commit would otherwise make
    // us run Lighthouse against the old build.
    if (pr.head.sha !== sha) {
      log.info(`PR #${pr.number} — stale deployment ignored (${sha.slice(0, 7)} ≠ HEAD ${pr.head.sha.slice(0, 7)})`);
      return { ok: true, ignored: 'sha is not PR head' };
    }

    const prNumber = pr.number;
    store.setPreviewUrl(prNumber, targetUrl);
    log.info(`PR #${prNumber} — ${source} preview ready: ${targetUrl}`);

    if (store.takePending(prNumber)) {
      const repoConfig = await loadRepoConfig({ octokit, owner, repo, staticConfig, ref: sha, log });
      const previewWaitMs = (repoConfig.preview_wait_seconds ?? 15) * 1000;
      log.info(`PR #${prNumber} — waiting ${previewWaitMs / 1000}s for assets to stabilize...`);
      await new Promise((resolve) => setTimeout(resolve, previewWaitMs));
      await runAndPostReport({
        octokit, owner, repo, prNumber, sha,
        headRef: pr.head.ref, baseRef: pr.base.ref,
        previewUrl: targetUrl, source, log, repoConfig,
      });
    }
    return { ok: true, pr: prNumber, target_url: targetUrl };
  }

  // Runs the report for a PR whose preview URL is already known (PR opened or
  // reopened after the deployment landed).
  async function runReport({ octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, log }) {
    const repoConfig = await loadRepoConfig({ octokit, owner, repo, staticConfig, ref: sha, log });
    return runAndPostReport({
      octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, log, repoConfig,
    });
  }

  return { handlePreviewUrl, runReport };
}

// Worst-of merge across form factors so the commit status reflects the harshest
// outcome on each metric (fail beats warn beats pass).
const SEVERITY = { fail: 2, warn: 1, pass: 0 };
function combineStatuses(statusesByForm) {
  const combined = {};
  for (const statuses of Object.values(statusesByForm)) {
    for (const [metric, level] of Object.entries(statuses)) {
      if (!combined[metric] || SEVERITY[level] > SEVERITY[combined[metric]]) {
        combined[metric] = level;
      }
    }
  }
  return combined;
}

function summarizePerf(scores) {
  const parts = [];
  for (const ff of FORM_FACTORS) {
    const icon = ff === 'mobile' ? '📱' : '💻';
    const pr = scores[ff].pr;
    parts.push(pr ? `${icon} perf ${pr.performance} · LCP ${pr.lcp.toFixed(1)}s · TBT ${Math.round(pr.tbt)}ms` : `${icon} —`);
  }
  return parts.join(' | ');
}
