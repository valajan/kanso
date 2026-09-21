import { Octokit } from '@octokit/core';

// GitHub implementation of the forge interface (see ./index.js).
//
// Built either from an existing authenticated client (the webhook path passes
// its App installation Octokit) or from a raw token (the /v1/audit path passes
// the caller's CI token). Both are just an Octokit with different credentials,
// so the rest of the adapter is identical — which is precisely what lets the
// same pipeline serve an App installation and a CI job.
const COMMENT_SCAN_PAGES = 3;
const PER_PAGE = 100;

// GitHub commit statuses use the same vocabulary as the forge interface except
// that we never emit 'error'; a failed audit is reported as a failure.
const STATE_MAP = { pending: 'pending', success: 'success', failure: 'failure' };

export function createGithubForge({ octokit, token, owner, repo, baseUrl }) {
  if (!octokit && !token) throw new Error('github forge needs an octokit or a token');
  if (!owner || !repo) throw new Error('github forge needs owner and repo');

  const client = octokit ?? new Octokit({ auth: token, ...(baseUrl ? { baseUrl } : {}) });
  const scope = { owner, repo };

  // Resolves a missing resource to null so callers never read HTTP codes.
  //
  // 403 is only folded into null where "cannot see it" and "not there" call for
  // the same handling — reading an optional config file, or scanning for a
  // previous comment. Everywhere else it must propagate: a token with the wrong
  // scopes has to be reported as a permission problem, not as a missing PR.
  async function orNull(promise, { alsoOn = [] } = {}) {
    try {
      return await promise;
    } catch (err) {
      if (err?.status === 404 || alsoOn.includes(err?.status)) return null;
      throw err;
    }
  }

  return {
    kind: 'github',
    slug: `${owner}/${repo}`,

    async getPullRequest({ prNumber }) {
      const res = await orNull(
        client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...scope, pull_number: prNumber,
        })
      );
      if (!res) return null;
      const pr = res.data;
      return {
        number: pr.number,
        state: pr.state,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
      };
    },

    // Finds Kanso's own comment by the hidden marker it embeds, so a re-run
    // edits the existing report instead of stacking a new one. Stateless by
    // design — it replaces the in-memory comment bookkeeping the webhook path
    // used to need, and survives restarts and multi-instance deployments.
    async findComment({ prNumber, marker }) {
      for (let page = 1; page <= COMMENT_SCAN_PAGES; page++) {
        const res = await orNull(
          client.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            ...scope, issue_number: prNumber, per_page: PER_PAGE, page,
          }),
          { alsoOn: [403] }
        );
        if (!res) return null;
        const hit = res.data.find((c) => c.body?.includes(marker));
        if (hit) return hit.id;
        if (res.data.length < PER_PAGE) return null;
      }
      return null;
    },

    async postComment({ prNumber, body }) {
      const { data } = await client.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        { ...scope, issue_number: prNumber, body }
      );
      return data.id;
    },

    async editComment({ commentId, body }) {
      await client.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        ...scope, comment_id: commentId, body,
      });
    },

    async setStatus({ sha, state, description, context = 'kanso', targetUrl }) {
      await client.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
        ...scope,
        sha,
        state: STATE_MAP[state] ?? 'success',
        description,
        context,
        ...(targetUrl ? { target_url: targetUrl } : {}),
      });
    },

    async getFileContent({ path, ref }) {
      const res = await orNull(
        client.request('GET /repos/{owner}/{repo}/contents/{path}', {
          ...scope, path, ...(ref ? { ref } : {}),
        }),
        { alsoOn: [403] }
      );
      if (!res?.data?.content) return null;
      return Buffer.from(res.data.content, 'base64').toString('utf8');
    },
  };
}
