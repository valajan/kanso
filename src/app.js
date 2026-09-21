import Fastify from 'fastify';
import { registerAuditRoutes } from './api/audit-route.js';

// Upper bound on any request body. The API's own fields are capped far lower in
// src/api/validate.js. This is the outer guard against a body large enough to
// be a denial-of-service on its own.
const MAX_BODY_BYTES = 1024 * 1024;

// Builds the configured Fastify instance: logging, the JSON parser, and the
// /v1/audit trigger (any CI, any platform).
//
// `logger` overrides the environment-derived default.
export function buildApp({ env, orchestrator, queue, rateLimiter, verifyUrl, logger }) {
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

  const forgeOptions = env.runtime?.githubApiUrl ? { baseUrl: env.runtime.githubApiUrl } : {};

  fastify.get('/health', async () => ({ status: 'ok', queue: queue.stats() }));

  registerAuditRoutes(fastify, { orchestrator, queue, rateLimiter, verifyUrl, forgeOptions });

  return fastify;
}
