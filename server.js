import 'dotenv/config';
import { App } from '@octokit/app';
import { loadEnv } from './src/config/env.js';
import { loadStaticConfig } from './src/config/static-config.js';
import { PreviewStore } from './src/pipeline/state.js';
import { createOrchestrator } from './src/pipeline/orchestrator.js';
import { runLighthouse } from './src/lighthouse/runner.js';
import { buildApp } from './src/app.js';

// Bootstrap: wire the dependencies together and start the HTTP server.
// Application logic lives under src/ — see src/app.js for the request pipeline.
const env = loadEnv();
const staticConfig = loadStaticConfig();

const githubApp = new App({ appId: env.appId, privateKey: env.privateKey });
const store = new PreviewStore();
const orchestrator = createOrchestrator({ store, staticConfig, runLighthouse });
const app = buildApp({ env, githubApp, store, orchestrator });

app
  .listen({ port: env.port, host: '0.0.0.0' })
  .then((address) => {
    const b = staticConfig.budgets ?? {};
    app.log.info(`Kanso ready on ${address}`);
    app.log.info(
      `Budgets (fail) — perf≥${b.performance ?? '—'} | LCP≤${b.lcp ?? '—'}s | TBT≤${b.tbt ?? '—'}ms | CLS≤${b.cls ?? '—'} | FCP≤${b.fcp ?? '—'}s`
    );
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
