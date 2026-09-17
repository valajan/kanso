import Fastify from 'fastify';
import { createSignatureVerifier } from './webhook/signature.js';
import { routeWebhookEvent } from './webhook/router.js';
import { registerAuditRoutes } from './api/audit-route.js';
import { createForge } from './forge/index.js';
import { QueueFullError } from './pipeline/jobs.js';

// Upper bound on any request body. GitHub's pull_request payloads run to a few
// tens of kilobytes; the API's own fields are capped far lower in
// src/api/validate.js. This is the outer guard against a body large enough to
// be a denial-of-service on its own.
const MAX_BODY_BYTES = 1024 * 1024;

// Builds the configured Fastify instance: logging, the raw-body JSON parser
// (needed for HMAC verification), and the routes for both triggers —
// /webhook (GitHub App) and /v1/audit (any CI, any platform).
//
// `logger` overrides the environment-derived default — the acceptance suite
// passes `false` so request logs do not interleave with the test report.
export function buildApp({ env, githubApp, store, orchestrator, queue, rateLimiter, verifyUrl, logger }) {
  const isDev = process.env.NODE_ENV !== 'production';
  const fastify = Fastify({
    disableRequestLogging: true,
    bodyLimit: MAX_BODY_BYTES,
    logger: logger !== undefined ? logger : isDev
      ? {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname',
              messageFormat: '{msg}',
            },
          },
        }
      : { level: 'info' },
  });

  // Keep the raw body around: webhook signature verification must hash the
  // exact bytes GitHub sent, before any re-serialization.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err);
      }
    }
  );

  const verifySignature = createSignatureVerifier(env.webhookSecret);

  // Builds a forge bound to one repo from a GitHub App installation. Only the
  // webhook path uses this; /v1/audit builds its forge from the caller's token.
  const forgeForInstallation = async ({ installationId, owner, repo }) =>
    createForge({ kind: 'github', octokit: await githubApp.getInstallationOctokit(installationId), owner, repo });

  const forgeOptions = env.runtime?.githubApiUrl ? { baseUrl: env.runtime.githubApiUrl } : {};

  // Hands an audit to the background queue and returns immediately. A full
  // queue is logged and dropped rather than thrown: the webhook has no useful
  // way to retry, and answering 500 would only make GitHub redeliver into the
  // same saturated queue.
  const schedule = (run, meta) => {
    try {
      return queue.enqueue({ kind: 'webhook-audit', meta, run });
    } catch (err) {
      if (err instanceof QueueFullError) {
        fastify.log.warn(`audit dropped — ${err.message} (PR #${meta?.prNumber})`);
        return null;
      }
      throw err;
    }
  };

  fastify.get('/health', async () => ({ status: 'ok', queue: queue.stats() }));

  registerAuditRoutes(fastify, { orchestrator, queue, rateLimiter, verifyUrl, forgeOptions });

  fastify.post('/webhook', async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];
    const delivery = req.headers['x-github-delivery'];

    if (!verifySignature(req.rawBody, signature)) {
      req.log.warn(`Webhook rejected — invalid signature [${event} delivery:${delivery}]`);
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const result = await routeWebhookEvent({
      event,
      payload: req.body,
      forgeForInstallation,
      store,
      orchestrator,
      schedule,
      log: req.log,
    });

    if (result.code) reply.code(result.code);
    return result.body;
  });

  return fastify;
}
