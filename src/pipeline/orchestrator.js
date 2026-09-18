import { audit, FORM_FACTORS } from '../core/audit.js';
import { loadRepoConfig } from '../config/repo-config.js';
import { moduleConfig } from '../config/module-config.js';
import { formatComment, REPORT_MARKER, REPORT_TITLE, reportScores } from '../report/comment.js';
import { commitStatusPayload } from '../report/commit-status.js';
import {
  analyzePerformanceRegression,
  formatPendingNote,
  replaceAnalysisSection,
} from '../ai-analysis/index.js';

// Builds the report pipeline. External dependencies are injected so the
// pipeline can be exercised in isolation:
// - store:         PreviewStore coordinating webhook state (legacy trigger only)
// - staticConfig:  parsed config.yml, the base for per-repo config merges
// - runLighthouse: the audit runner, handed to src/core/audit.js
// - gptClient:     the AI analysis client, or null when none is configured
// - verifyUrl:     async URL guard; re-checked here, immediately before the
//                  audit, to narrow the window in which a name validated at
//                  admission could have been re-pointed at a private address
//
// Every platform call goes through `forge` (src/forge), so nothing in this file
// knows it is talking to GitHub.
export function createOrchestrator({ store, staticConfig, runLighthouse, gptClient = null, verifyUrl = null }) {
  // Finds the report comment to write into: the id the caller already created,
  // else Kanso's previous report on this PR (located by its hidden marker),
  // else a fresh comment. The marker lookup is what keeps a PR to a single,
  // continuously updated report instead of one comment per push.
  async function postOrEditComment({ forge, prNumber, body, commentId }) {
    const target = commentId ?? (await forge.findComment({ prNumber, marker: REPORT_MARKER }));
    if (target != null) {
      await forge.editComment({ commentId: target, body });
      return target;
    }
    return forge.postComment({ prNumber, body });
  }

  async function guard(url, label) {
    if (!verifyUrl || !url) return;
    try {
      await verifyUrl(url);
    } catch (err) {
      const reason = err?.reason ? `${err.reason}: ${err.message}` : err.message;
      throw new Error(`${label} URL rejected — ${reason}`);
    }
  }

  // Audits the PR preview against the reference (src/core/audit.js), then
  // posts the report comment and commit status, and triggers AI analysis on a
  // real regression. Returns the conclusion so a CI caller can fail its build on it.
  async function runAndPostReport({ forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected = true, log, repoConfig, commentId }) {
    const budget = moduleConfig(repoConfig, 'performance').budgets ?? {};
    // A repo can ask for AI analysis, but it only runs if the deployment has a
    // provider configured — otherwise we'd promise a section we cannot deliver.
    const aiAnalysisEnabled = repoConfig.ai_analysis === true && gptClient != null;
    // A request-supplied reference wins over the configured one: the CI often
    // knows the base branch's own preview, which is a fairer comparison than prod.
    let reference = baseUrl ?? repoConfig.base_url;

    // Re-validate right before dialling out. A URL that passed admission may
    // have been re-pointed since; this is the last chance to catch it.
    try {
      await guard(previewUrl, 'Preview');
    } catch (err) {
      log.warn(`PR #${prNumber} — ${err.message}`);
      await postOrEditComment({
        forge, prNumber, commentId,
        body: `${REPORT_MARKER}\n## ${REPORT_TITLE}\n\n⚠️ ${err.message}`,
      });
      return { ok: false, conclusion: 'error', error: err.message };
    }

    // A rejected reference only costs the comparison column, so it degrades to
    // "no reference" rather than sinking a report the PR still needs.
    try {
      await guard(reference, 'Reference');
    } catch (err) {
      log.warn(`PR #${prNumber} — ${err.message}; auditing preview only`);
      reference = null;
    }

    if (sha) {
      await forge
        .setStatus({ sha, state: 'pending', description: 'Running Lighthouse audits…' })
        .catch((err) => log.warn(`PR #${prNumber} — failed to post pending status: ${err.message}`));
    }

    log.info(`PR #${prNumber} — Lighthouse auditing ${previewUrl}${reference ? ` against ${reference}` : ''} (mobile + desktop)...`);
    const result = await audit({ url: previewUrl, baseline: reference, config: repoConfig, runLighthouse });

    // If the preview failed on every form factor, we have nothing meaningful to report.
    if (!result.ok) {
      log.error(`PR #${prNumber} — Lighthouse failed on preview (mobile + desktop): ${result.error}`);
      await postOrEditComment({
        forge, prNumber, commentId,
        body: `${REPORT_MARKER}\n## ${REPORT_TITLE}\n\n⚠️ Lighthouse analysis failed: \`${result.error}\``,
      });
      if (sha) {
        await forge
          .setStatus({ sha, state: 'failure', description: 'Lighthouse audit failed' })
          .catch(() => {});
      }
      return { ok: false, conclusion: 'error', error: result.error };
    }

    // Surface soft failures (one form factor or the reference) without aborting.
    for (const failure of result.failures) {
      const label = `${failure.formFactor} ${failure.side === 'current' ? 'preview' : 'reference'}`;
      log.warn(`PR #${prNumber} — Lighthouse failed on ${label}: ${failure.error}`);
    }

    const perf = result.modules.performance;
    const scores = reportScores(perf.scores);
    const { regressions } = perf;

    const baseBody = formatComment(scores, {
      previewUrl, headRef, baseRef, source, budget, detected, modules: result.modules,
      ...(perf.referenceKind === 'budgets' ? { refLabel: 'budgets' } : { refLabel: baseRef ?? 'main' }),
    });

    const initialBody = aiAnalysisEnabled && regressions.length > 0
      ? baseBody + formatPendingNote(regressions.map((r) => r.metric))
      : baseBody;

    const reportCommentId = await postOrEditComment({ forge, prNumber, body: initialBody, commentId });

    if (sha) {
      const { state, description } = commitStatusPayload(result.modules);
      await forge
        .setStatus({ sha, state, description })
        .catch((err) => log.warn(`PR #${prNumber} — failed to post commit status: ${err.message}`));
    }

    // Detached on purpose: the verdict is already final without it, so neither a
    // webhook nor a waiting CI job should block on an LLM round-trip.
    if (aiAnalysisEnabled && regressions.length > 0) {
      analyzePerformanceRegression({ forge, prNumber, sha, regressions, gptClient, log })
        .then(async (analysis) => {
          if (!analysis?.section) return;
          const updatedBody = replaceAnalysisSection(initialBody, analysis.section);
          await forge.editComment({ commentId: reportCommentId, body: updatedBody });
          const n = analysis.structured?.comments?.length ?? 0;
          log.info(`PR #${prNumber} — AI analysis posted (${n} inline comment${n !== 1 ? 's' : ''})`);
        })
        .catch((err) => log.warn(`PR #${prNumber} — AI analysis failed: ${err.message}`));
    }

    const { conclusion } = result;
    const icon = conclusion === 'fail' ? '❌' : conclusion === 'warn' ? '⚠️' : '✅';
    log.info(`PR #${prNumber} ${icon} report posted — ${summarizePerf(scores)}`);
    return { ok: true, conclusion, statuses: perf.levels, modules: result.modules, scores, commentId: reportCommentId };
  }

  // Handles a preview-ready provider event: maps the deployment SHA to its open
  // PR, records the preview URL, and — if the PR was parked waiting for this
  // deployment — runs the report.
  //
  // Returns as soon as the PR is resolved: the audit itself is handed to the
  // caller's `schedule` callback so the webhook response is not held open for
  // the minutes an audit takes.
  async function handlePreviewUrl({ forge, sha, targetUrl, source, log, schedule }) {
    const pr = await forge.findOpenPullRequestForSha({ sha });
    if (!pr) return { ok: true, ignored: 'no open PR for sha' };

    // A late-arriving status event for a superseded commit would otherwise make
    // us run Lighthouse against the old build.
    if (pr.headSha !== sha) {
      log.info(`PR #${pr.number} — stale deployment ignored (${sha.slice(0, 7)} ≠ HEAD ${pr.headSha.slice(0, 7)})`);
      return { ok: true, ignored: 'sha is not PR head' };
    }

    const prNumber = pr.number;
    store.setPreviewUrl(prNumber, targetUrl);
    log.info(`PR #${prNumber} — ${source} preview ready: ${targetUrl}`);

    if (!store.isPending(prNumber)) {
      return { ok: true, pr: prNumber, target_url: targetUrl };
    }

    const scheduled = schedule(async () => {
      const repoConfig = await loadRepoConfig({ forge, staticConfig, ref: sha, log });
      // Preview hosts report "ready" before the CDN has finished propagating
      // assets; auditing immediately measures a half-warm deployment.
      const previewWaitMs = (repoConfig.preview_wait_seconds ?? 15) * 1000;
      log.info(`PR #${prNumber} — waiting ${previewWaitMs / 1000}s for assets to stabilize...`);
      await new Promise((resolve) => setTimeout(resolve, previewWaitMs));
      return runAndPostReport({
        forge, prNumber, sha,
        headRef: pr.headRef, baseRef: pr.baseRef,
        previewUrl: targetUrl, source, log, repoConfig,
      });
    }, { prNumber, sha, previewUrl: targetUrl });

    // Keep the PR parked when the queue refused the work, so the next
    // deployment event for it still triggers a report.
    if (!scheduled) {
      log.warn(`PR #${prNumber} — audit not scheduled, staying pending`);
      return { ok: true, pr: prNumber, target_url: targetUrl, queued: false };
    }
    store.takePending(prNumber);
    return { ok: true, pr: prNumber, target_url: targetUrl, job: scheduled.id };
  }

  // Runs the report for a PR whose preview URL is already known (PR opened or
  // reopened after the deployment landed), or requested directly through the API.
  async function runReport({ forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected, log, repoConfig, inlineConfig, commentId }) {
    const config = repoConfig ?? (await loadRepoConfig({ forge, staticConfig, ref: sha, log, inlineConfig }));
    return runAndPostReport({
      forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected, log,
      repoConfig: config, commentId,
    });
  }

  return { handlePreviewUrl, runReport, postOrEditComment };
}

// The PR report and the /v1/audit response name the two sides `pr` and `ref`.
function summarizePerf(scores) {
  const parts = [];
  for (const ff of FORM_FACTORS) {
    const icon = ff === 'mobile' ? '📱' : '💻';
    const pr = scores[ff].pr;
    parts.push(pr ? `${icon} perf ${pr.performance} · LCP ${Math.round(pr.lcp)}ms · TBT ${Math.round(pr.tbt)}ms` : `${icon} —`);
  }
  return parts.join(' | ');
}
