import { audit, FORM_FACTORS } from '../core/audit.js';
import { loadRepoConfig } from '../config/repo-config.js';
import { moduleConfig } from '../config/module-config.js';
import { formatComment, REPORT_MARKER, REPORT_TITLE, reportScores } from '../report/comment.js';
import { commitStatusPayload } from '../report/commit-status.js';

// Builds the report pipeline. External dependencies are injected so the
// pipeline can be exercised in isolation:
// - staticConfig:  parsed config.yml, the base for per-repo config merges
// - runLighthouse: the audit runner, handed to src/core/audit.js
// - verifyUrl:     async URL guard; re-checked here, immediately before the
//                  audit, to narrow the window in which a name validated at
//                  admission could have been re-pointed at a private address
//
// Every platform call goes through `forge` (src/forge), so nothing in this file
// knows it is talking to GitHub.
export function createOrchestrator({ staticConfig, runLighthouse, verifyUrl = null }) {
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

  // Audits the PR preview against the reference (src/core/audit.js), then posts
  // the report comment and commit status. Returns the conclusion so a CI caller
  // can fail its build on it.
  async function runAndPostReport({ forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected = true, log, repoConfig, commentId }) {
    const budget = moduleConfig(repoConfig, 'performance').budgets ?? {};
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

    const body = formatComment(scores, {
      previewUrl, headRef, baseRef, source, budget, detected, modules: result.modules,
      referenceKind: perf.referenceKind,
      ...(perf.referenceKind === 'budgets' ? { refLabel: 'budgets' } : { refLabel: baseRef ?? 'main' }),
    });

    const reportCommentId = await postOrEditComment({ forge, prNumber, body, commentId });

    if (sha) {
      const { state, description } = commitStatusPayload(result.modules);
      await forge
        .setStatus({ sha, state, description })
        .catch((err) => log.warn(`PR #${prNumber} — failed to post commit status: ${err.message}`));
    }

    const { conclusion } = result;
    const icon = conclusion === 'fail' ? '❌' : conclusion === 'warn' ? '⚠️' : '✅';
    log.info(`PR #${prNumber} ${icon} report posted — ${summarizePerf(scores)}`);
    return { ok: true, conclusion, statuses: perf.levels, modules: result.modules, scores, commentId: reportCommentId };
  }

  // Runs the report for a pull request whose preview URL the caller already
  // knows: the CI job has just deployed it.
  async function runReport({ forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected, log, repoConfig, inlineConfig, commentId }) {
    const config = repoConfig ?? (await loadRepoConfig({ forge, staticConfig, ref: sha, log, inlineConfig }));
    return runAndPostReport({
      forge, prNumber, sha, headRef, baseRef, previewUrl, baseUrl, source, detected, log,
      repoConfig: config, commentId,
    });
  }

  return { runReport, postOrEditComment };
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
