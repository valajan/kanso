import Fastify from 'fastify';
import { createSignatureVerifier } from './webhook/signature.js';
import { routeWebhookEvent } from './webhook/router.js';

// Builds the configured Fastify instance: logging, the raw-body JSON parser
// (needed for HMAC verification), and the /health and /webhook routes.
export function buildApp({ env, githubApp, store, orchestrator }) {
  const fastify = Fastify({
    disableRequestLogging: true,
    logger: {
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
    },
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

  fastify.get('/health', async () => ({ status: 'ok' }));

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
      githubApp,
      store,
      orchestrator,
      log: req.log,
    });

    if (result.code) reply.code(result.code);
    return result.body;
  });

  return fastify;
}
