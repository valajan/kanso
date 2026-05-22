// Railway does not expose preview URLs through a deployment event — the URL
// only appears in the comment its `railway` bot posts on the PR. The bot edits
// that comment several times during a build, so we act only once the comment
// contains a success marker (✅), and dedup by PR + head SHA.
//
// This provider needs an authenticated client to resolve the PR's head SHA and
// open state; it calls getOctokit() lazily so a missing installation id is
// reported the same way the legacy handler reported it.
export default {
  name: 'railway',
  event: 'issue_comment',

  async resolve(payload, { getOctokit, owner, repo, store, log }) {
    if (payload.action !== 'created' && payload.action !== 'edited') {
      return { ignored: { ok: true, ignored_action: payload.action } };
    }
    if (!payload.issue?.pull_request) {
      return { ignored: { ok: true, ignored: 'not a PR comment' } };
    }

    const commenter = (payload.comment?.user?.login ?? '').toLowerCase();
    if (!commenter.includes('railway')) {
      return { ignored: { ok: true, ignored: 'not railway bot' } };
    }

    const body = payload.comment?.body ?? '';
    if (!body.includes('✅')) {
      return { ignored: { ok: true, ignored: 'railway deployment not yet successful' } };
    }

    const match = body.match(/https:\/\/[^\s)>\]"]+\.up\.railway\.app\b[^\s)>\]"]*/);
    if (!match) {
      log.warn('Railway bot comment: no .up.railway.app URL found');
      return { ignored: { ok: true, ignored: 'no railway preview URL in comment' } };
    }

    const targetUrl = match[0];
    const prNumber = payload.issue.number;

    const octokit = await getOctokit();
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner, repo, pull_number: prNumber }
    );
    if (pr.state !== 'open') {
      return { ignored: { ok: true, ignored: 'PR not open' } };
    }

    const dedupKey = `railway:${prNumber}-${pr.head.sha}`;
    if (store.hasSeen(dedupKey)) {
      return { ignored: { ok: true, ignored: 'duplicate railway deployment' } };
    }
    store.markSeen(dedupKey);

    log.info(`PR #${prNumber} — Railway bot posted preview: ${targetUrl}`);
    return { preview: { sha: pr.head.sha, targetUrl, source: 'Railway' } };
  },
};
