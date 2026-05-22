// Handles the `pull_request` lifecycle (opened / reopened / synchronize).
//
// Because a PR is often opened before its preview deployment exists, this
// handler coordinates with the provider events through the PreviewStore:
// - synchronize: invalidate the stale preview and park the PR as pending
// - opened/reopened with a known preview: run the report immediately
// - opened/reopened without a preview: park the PR and post a placeholder
//
// Returns { code?, body }: `code` is set only for the 400 emitted when the
// webhook lacks an installation id.
export async function handlePullRequest({ payload, githubApp, store, runReport, log }) {
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
      const octokit = await githubApp.getInstallationOctokit(installationId);
      const { data: comment } = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { owner, repo, issue_number: prNumber, body: '⏳ Waiting for deployment preview...' }
      );
      store.setWaitingComment(prNumber, comment.id);
      log.info(`PR #${prNumber} — no preview yet, posted placeholder comment`);
    }
    return { body: { ok: true, pending_deployment: true } };
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  await runReport({ octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, log });
  return { body: { ok: true } };
}
