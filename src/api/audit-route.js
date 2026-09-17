import { createForge } from '../forge/index.js';
import { formatPlaceholder, REPORT_MARKER } from '../report/comment.js';
import { QueueFullError } from '../pipeline/jobs.js';
import { UrlGuardError } from '../security/url-guard.js';
import { validateAuditRequest, extractToken, ValidationError } from './validate.js';

// The platform-agnostic trigger: any CI, on any host, posts the preview URL it
// just deployed and Kanso audits it.
//
// This replaces the webhook path's job of *discovering* a preview URL by
// reverse-engineering five different providers' events, and with it the
// cross-request state that discovery needed. One request carries everything.
//
// Authorization, in one move: Kanso writes the placeholder comment **with the
// caller's own token**, before scheduling any audit. If that write succeeds the
// caller has demonstrably got comment access to the PR they named; if it fails
// the request is refused. There is no shared secret to distribute or leak, no
// per-repo credential store, and — because Kanso only ever acts with the
// caller's token on the caller's repo — no privilege for a confused-deputy
// attack to borrow. It costs one API call and spends no CPU before the caller
// is authorized.
export function registerAuditRoutes(fastify, { orchestrator, queue, rateLimiter, verifyUrl, makeForge = createForge, forgeOptions = {} }) {
  fastify.post('/v1/audit', async (req, reply) => {
    let input;
    let token;
    try {
      token = extractToken(req.headers.authorization);
      input = validateAuditRequest(req.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(err.field === 'authorization' ? 401 : 400)
          .send({ error: 'invalid_request', field: err.field, message: err.message });
      }
      throw err;
    }

    // Cheapest gate first: it costs nothing and it is what stops a runaway CI
    // loop from consuming the instance's Lighthouse capacity and API quota.
    const limit = rateLimiter.take(input.slug);
    if (!limit.allowed) {
      return reply.code(429).header('retry-after', limit.retryAfterSeconds)
        .send({ error: 'rate_limited', message: `Too many audits for ${input.slug}`, retryAfterSeconds: limit.retryAfterSeconds });
    }

    // Vet every URL we might fetch before anything else touches the network.
    try {
      await verifyUrl(input.previewUrl);
      if (input.baseUrl) await verifyUrl(input.baseUrl);
    } catch (err) {
      if (err instanceof UrlGuardError) {
        req.log.warn(`${input.slug} — URL rejected (${err.reason}): ${err.message}`);
        return reply.code(400).send({ error: 'url_rejected', reason: err.reason, message: err.message });
      }
      throw err;
    }

    let forge;
    try {
      forge = makeForge({ kind: input.forge, token, owner: input.owner, repo: input.repo, ...forgeOptions });
    } catch (err) {
      return reply.code(400).send({ error: 'unsupported_forge', message: err.message });
    }

    // Re-derive the PR facts server-side. Branch names and the head SHA come
    // from the forge, never from the request body, so nothing the caller writes
    // can reach the rendered comment.
    let pr;
    try {
      pr = await forge.getPullRequest({ prNumber: input.pr });
    } catch (err) {
      req.log.warn(`${input.slug}#${input.pr} — cannot read PR: ${err.message}`);
      return reply.code(401).send({ error: 'unauthorized', message: 'The supplied token cannot read this pull request' });
    }
    if (!pr) {
      return reply.code(404).send({ error: 'pr_not_found', message: `${input.slug}#${input.pr} not found` });
    }
    if (pr.state !== 'open') {
      return reply.code(409).send({ error: 'pr_not_open', message: `${input.slug}#${input.pr} is ${pr.state}` });
    }
    // Guard against auditing a build that has already been superseded.
    if (pr.headSha !== input.sha && !pr.headSha.startsWith(input.sha)) {
      return reply.code(409).send({
        error: 'stale_sha',
        message: `sha ${input.sha} is not the head of ${input.slug}#${input.pr} (${pr.headSha.slice(0, 7)})`,
      });
    }

    // The authorization probe. A successful write proves comment access; it also
    // gives the PR immediate feedback that an audit is under way, and returns the
    // comment the report will later be written into.
    const placeholder = formatPlaceholder({ previewUrl: input.previewUrl, source: input.source });
    let commentId;
    try {
      const existing = await forge.findComment({ prNumber: input.pr, marker: REPORT_MARKER });
      if (existing != null) {
        await forge.editComment({ commentId: existing, body: placeholder });
        commentId = existing;
      } else {
        commentId = await forge.postComment({ prNumber: input.pr, body: placeholder });
      }
    } catch (err) {
      req.log.warn(`${input.slug}#${input.pr} — write probe failed: ${err.message}`);
      return reply.code(403).send({
        error: 'forbidden',
        message: 'The supplied token cannot comment on this pull request. On GitHub Actions, grant the job `pull-requests: write` and `statuses: write`.',
      });
    }

    let job;
    try {
      job = queue.enqueue({
        kind: 'api-audit',
        meta: { slug: input.slug, pr: input.pr, sha: pr.headSha },
        run: () => orchestrator.runReport({
          forge,
          prNumber: input.pr,
          sha: pr.headSha,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          previewUrl: input.previewUrl,
          baseUrl: input.baseUrl ?? undefined,
          source: input.source,
          // The CI told us the URL; nothing was detected.
          detected: false,
          inlineConfig: input.config ?? undefined,
          commentId,
          log: req.log,
        }),
      });
    } catch (err) {
      if (err instanceof QueueFullError) {
        return reply.code(429).header('retry-after', 60)
          .send({ error: 'queue_full', message: err.message, retryAfterSeconds: 60 });
      }
      throw err;
    }

    req.log.info(`${input.slug}#${input.pr} — audit queued (job ${job.id}) for ${input.previewUrl}`);
    return reply.code(202).send({
      jobId: job.id,
      status: job.status,
      statusUrl: `/v1/audit/${job.id}`,
      commentId,
      pr: { number: pr.number, headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef },
    });
  });

  // Lets a CI job wait for the verdict and fail its build on a regression —
  // something the webhook trigger could never offer, because nothing in the CI
  // knew an audit was happening. The job id is an unguessable UUID and the
  // payload only restates what the PR comment already shows publicly.
  fastify.get('/v1/audit/:id', async (req, reply) => {
    const job = queue.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job_not_found', message: 'Unknown or expired job id' });

    return {
      jobId: job.id,
      status: job.status,
      conclusion: job.result?.conclusion ?? null,
      scores: job.result?.scores ?? null,
      statuses: job.result?.statuses ?? null,
      // Per-module levels and detail: `statuses` is performance's alone, and an
      // audit now has more than one module to answer for.
      modules: job.result?.modules ?? null,
      commentId: job.result?.commentId ?? null,
      error: job.error ?? job.result?.error ?? null,
      queuedMs: job.startedAt ? job.startedAt - job.createdAt : null,
      durationMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
    };
  });
}
