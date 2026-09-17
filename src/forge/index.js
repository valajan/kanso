import { createGithubForge } from './github.js';

// Forge adapters: the single boundary between Kanso and a code-hosting
// platform. Every call that reads or writes on a PR goes through this
// interface, so supporting GitLab or Bitbucket means writing one more adapter
// rather than touching the pipeline.
//
// A forge is always bound to one repository, and carries the credentials it
// was built with. Two call sites build one:
// - the webhook path, from a GitHub App installation token
// - the /v1/audit path, from the caller's own CI token
//
// The interface every adapter implements:
//
//   kind                                  → 'github' | 'gitlab' | ...
//   slug                                  → 'owner/repo', for logs
//   getPullRequest({ prNumber })          → { number, state, headSha, headRef, baseRef } | null
//   findComment({ prNumber, marker })     → commentId | null
//   postComment({ prNumber, body })       → commentId
//   editComment({ commentId, body })      → void
//   setStatus({ sha, state, description, context, targetUrl })
//                                         → void   (state: pending|success|failure)
//   getPullRequestFiles({ prNumber })     → [{ filename, status, patch }]
//   postReview({ prNumber, sha, comments })
//                                         → void
//   getFileContent({ path, ref })         → string | null   (null when absent)
//
// Adapters normalize platform errors: a missing resource resolves to null
// rather than throwing, so callers never branch on HTTP status codes.
const ADAPTERS = {
  github: createGithubForge,
};

export function createForge({ kind = 'github', ...options }) {
  const factory = ADAPTERS[kind];
  if (!factory) {
    throw new Error(`Unsupported forge: ${kind} (available: ${Object.keys(ADAPTERS).join(', ')})`);
  }
  return factory(options);
}

export function supportedForges() {
  return Object.keys(ADAPTERS);
}

export { createGithubForge };
