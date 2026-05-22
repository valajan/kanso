import { providerEvents } from '../providers/index.js';
import { dispatchProviderEvent } from './provider-dispatcher.js';
import { handlePullRequest } from './pull-request-handler.js';

// GitHub webhook events handled by a preview provider, derived from the
// registry so registering a provider on a new event needs no change here.
const PROVIDER_EVENTS = providerEvents();

// Aiguillage par type d'événement GitHub. Returns { code?, body }.
export async function routeWebhookEvent({ event, payload, githubApp, store, orchestrator, log }) {
  if (event === 'ping') {
    return { body: { ok: true, pong: true } };
  }

  if (PROVIDER_EVENTS.has(event)) {
    return dispatchProviderEvent({
      event, payload, githubApp, store,
      handlePreviewUrl: orchestrator.handlePreviewUrl,
      log,
    });
  }

  if (event === 'pull_request') {
    return handlePullRequest({
      payload, githubApp, store,
      runReport: orchestrator.runReport,
      log,
    });
  }

  return { body: { ok: true, ignored_event: event } };
}
