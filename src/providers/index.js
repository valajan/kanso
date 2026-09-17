import netlify from './netlify.js';
import deploymentStatus from './deployment-status.js';
import cloudflare from './cloudflare.js';
import amplify from './amplify.js';
import railway from './railway.js';

// Registry of preview-provider strategies.
//
// Each provider is a self-contained module exposing:
//   - name:  identifier for logging
//   - event: the single GitHub webhook event it reacts to
//   - resolve(payload, ctx): async; returns one of
//       null                  → not handled by this provider; try the next one
//       { ignored: <body> }    → handled but skipped; <body> is the HTTP response
//       { preview: { sha, targetUrl, source } } → a preview is ready
//
//     ctx provides: { getForge, owner, repo, store, log }
//
// To support a new host, add a provider module and one line to this array —
// nothing else in the webhook pipeline needs to change.
const PROVIDERS = [netlify, deploymentStatus, cloudflare, amplify, railway];

// Response body returned when an event reaches the dispatcher but no provider
// claims it. Keyed by event; falls back to a generic ignored_event body.
const NO_MATCH = {
  check_run: { ok: true, ignored: 'check_run not from cloudflare or amplify' },
};

export function providerEvents() {
  return new Set(PROVIDERS.map((p) => p.event));
}

export function providersForEvent(event) {
  return PROVIDERS.filter((p) => p.event === event);
}

export function noMatchResponse(event) {
  return NO_MATCH[event] ?? { ok: true, ignored_event: event };
}
