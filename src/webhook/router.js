import { providerEvents } from '../providers/index.js';
import { dispatchProviderEvent } from './provider-dispatcher.js';
import { handlePullRequest } from './pull-request-handler.js';

// GitHub webhook events handled by a preview provider, derived from the
// registry so registering a provider on a new event needs no change here.
const PROVIDER_EVENTS = providerEvents();

// Aiguillage par type d'événement GitHub. Returns { code?, body }.
//
// Everything on this path is cheap — a couple of API calls at most. The audit
// itself is handed to `schedule`, so the handler answers well inside GitHub's
// 10-second delivery timeout.
export async function routeWebhookEvent({ event, payload, forgeForInstallation, store, orchestrator, schedule, log }) {
  if (event === 'ping') {
    return { body: { ok: true, pong: true } };
  }

  if (PROVIDER_EVENTS.has(event)) {
    return dispatchProviderEvent({
      event, payload, forgeForInstallation, store,
      handlePreviewUrl: orchestrator.handlePreviewUrl,
      schedule,
      log,
    });
  }

  if (event === 'pull_request') {
    return handlePullRequest({
      payload, forgeForInstallation, store,
      runReport: orchestrator.runReport,
      schedule,
      log,
    });
  }

  return { body: { ok: true, ignored_event: event } };
}
