// In-memory coordination state for the legacy webhook trigger: it bridges the
// two async webhook streams — the pull_request lifecycle and the preview-ready
// provider events — which arrive in an order nobody controls.
//
// A PR opened before its preview is deployed is parked as "pending" with a
// placeholder comment; when the provider event arrives the report runs. Dedup
// keys guard against providers that emit the same deployment more than once.
//
// State is process-local and ephemeral by design — a restart re-derives it from
// subsequent webhooks. That also means it does not survive horizontal scaling:
// with several instances behind a load balancer, the pull_request event and the
// deployment event can land on different ones. The /v1/audit trigger has no such
// constraint — the caller supplies the preview URL, so nothing needs to be
// remembered between two requests — which is the main reason to prefer it.
const MAX_SEEN = 5_000;

export class PreviewStore {
  #previewUrls = new Map();
  #pendingPRs = new Map();
  #seen = new Set();

  setPreviewUrl(prNumber, targetUrl) {
    this.#previewUrls.set(prNumber, targetUrl);
  }

  getPreviewUrl(prNumber) {
    return this.#previewUrls.get(prNumber);
  }

  clearPreviewUrl(prNumber) {
    this.#previewUrls.delete(prNumber);
  }

  markPending(prNumber, info = {}) {
    this.#pendingPRs.set(prNumber, info);
  }

  isPending(prNumber) {
    return this.#pendingPRs.has(prNumber);
  }

  // Removes the pending entry and returns whether one existed.
  takePending(prNumber) {
    return this.#pendingPRs.delete(prNumber);
  }

  hasSeen(key) {
    return this.#seen.has(key);
  }

  // Bounded: a long-running process sees an unbounded number of deployments, and
  // the oldest keys can never match again — the PRs they belong to are closed.
  markSeen(key) {
    if (this.#seen.size >= MAX_SEEN) {
      const oldest = this.#seen.values().next().value;
      this.#seen.delete(oldest);
    }
    this.#seen.add(key);
  }
}
