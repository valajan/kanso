import 'dotenv/config';
import { App } from '@octokit/app';
import { loadEnv } from './src/config/env.js';
import { loadStaticConfig } from './src/config/static-config.js';
import { PreviewStore } from './src/pipeline/state.js';
import { JobQueue } from './src/pipeline/jobs.js';
import { createOrchestrator } from './src/pipeline/orchestrator.js';
import { runLighthouse } from './src/lighthouse/runner.js';
import { createGptClient } from './src/ai-analysis/gpt-client.js';
import { RateLimiter } from './src/security/rate-limit.js';
import { assertSafeUrl, parseAllowedHosts } from './src/security/url-guard.js';
import { buildApp } from './src/app.js';

// Bootstrap: wire the dependencies together and start the HTTP server.
// Application logic lives under src/ — see src/app.js for the request pipeline.
const env = loadEnv();
const staticConfig = loadStaticConfig();

const githubApp = new App({ appId: env.appId, privateKey: env.privateKey });
const store = new PreviewStore();
const gptClient = createGptClient(env.ai);

const allowedHosts = parseAllowedHosts(env.runtime.allowedPreviewHosts);
const verifyUrl = (url) => assertSafeUrl(url, { allowedHosts });

const queue = new JobQueue({
  concurrency: env.runtime.jobConcurrency,
  maxQueued: env.runtime.maxQueued,
});
const rateLimiter = new RateLimiter({ capacity: env.runtime.rateLimitPerMinute, windowMs: 60_000 });

const orchestrator = createOrchestrator({ store, staticConfig, runLighthouse, gptClient, verifyUrl });
const app = buildApp({ env, githubApp, store, orchestrator, queue, rateLimiter, verifyUrl });

app
  .listen({ port: env.port, host: '0.0.0.0' })
  .then((address) => {
    const b = staticConfig.budgets ?? {};
    app.log.info(`Kanso ready on ${address}`);
    app.log.info(
      `Budgets (fail) — perf≥${b.performance ?? '—'} | LCP≤${b.lcp ?? '—'}s | TBT≤${b.tbt ?? '—'}ms | CLS≤${b.cls ?? '—'} | FCP≤${b.fcp ?? '—'}s`
    );
    app.log.info(
      `Triggers — POST /webhook (GitHub App) · POST /v1/audit (any CI) — ${env.runtime.jobConcurrency} concurrent audits, ${env.runtime.maxQueued} queued max, ${env.runtime.rateLimitPerMinute}/min per repo`
    );
    app.log.info(
      allowedHosts.length > 0
        ? `Preview hosts — restricted to ${allowedHosts.join(', ')}`
        : 'Preview hosts — any public address (set KANSO_ALLOWED_PREVIEW_HOSTS to restrict)'
    );
    app.log.info(
      gptClient
        ? `AI analysis — ${gptClient.model} @ ${gptClient.baseUrl ?? 'api.openai.com'} (max ${env.ai.maxTokens} tokens, ${env.ai.timeoutMs}ms timeout)`
        : 'AI analysis — disabled (OPENAI_API_KEY not set)'
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
