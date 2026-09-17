import { formatPlaceholder, REPORT_MARKER } from '../report/comment.js';

// Handles the `pull_request` lifecycle (opened / reopened / synchronize).
//
// Because a PR is often opened before its preview deployment exists, this
// handler coordinates with the provider events through the PreviewStore:
// - synchronize: invalidate the stale preview and park the PR as pending
// - opened/reopened with a known preview: run the report
// - opened/reopened without a preview: park the PR and post a placeholder
//
// The report itself is handed to `schedule` rather than awaited: an audit takes
// minutes, and GitHub abandons a webhook delivery after 10 seconds.
//
// Returns { code?, body }: `code` is set only for the 400 emitted when the
// webhook lacks an installation id.
export async function handlePullRequest({ payload, forgeForInstallation, store, runReport, schedule, log }) {
  const { action } = payload;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const baseRef = payload.pull_request?.base?.ref;

  if (action !== 'opened' && action !== 'reopened' && action !== 'synchronize') {
    return { body: { ok: true, ignored_action: action } };
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return { code: 400, body: { error: 'missing installation id' } };
  }

  const prNumber = payload.pull_request.number;
  const headRef = payload.pull_request.head.ref;
  const sha = payload.pull_request.head.sha;

  if (action === 'synchronize') {
    // New commit: invalidate the stale preview URL and wait for the new deployment.
    store.clearPreviewUrl(prNumber);
    store.markPending(prNumber, { owner, repo, installationId });
    log.info(`PR #${prNumber} — new commit on ${headRef}, awaiting new preview deployment...`);
    return { body: { ok: true, awaiting_new_deployment: true } };
  }

  log.info(`PR #${prNumber} ${action} — ${owner}/${repo} (${headRef} → ${baseRef})`);
  const previewUrl = store.getPreviewUrl(prNumber);

  if (!previewUrl) {
    const alreadyPending = store.isPending(prNumber);
    store.markPending(prNumber, { owner, repo, installationId });
    if (!alreadyPending) {
      // The placeholder carries the report marker, so whichever run posts the
      // real report later finds and edits this very comment — no bookkeeping.
      const forge = await forgeForInstallation({ installationId, owner, repo });
      const body = formatPlaceholder({ message: 'Waiting for the preview deployment…' });
      const existing = await forge.findComment({ prNumber, marker: REPORT_MARKER });
      if (existing != null) await forge.editComment({ commentId: existing, body });
      else await forge.postComment({ prNumber, body });
      log.info(`PR #${prNumber} — no preview yet, posted placeholder comment`);
    }
    return { body: { ok: true, pending_deployment: true } };
  }

  const forge = await forgeForInstallation({ installationId, owner, repo });
  const job = schedule(
    () => runReport({ forge, prNumber, sha, headRef, baseRef, previewUrl, log }),
    { prNumber, sha, previewUrl }
  );
  return { body: { ok: true, job: job?.id } };
}
