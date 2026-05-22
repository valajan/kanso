// In-memory coordination state shared between the two async webhook streams:
// the pull_request lifecycle and the preview-ready provider events.
//
// A PR opened before its preview is deployed is parked as "pending" with a
// placeholder comment; when the provider event arrives the report runs and
// edits that comment in place. Dedup keys guard against providers that emit
// the same deployment more than once.
//
// State is process-local and ephemeral by design — a restart simply re-derives
// it from subsequent webhooks. Swap this class for a persistent store if that
// guarantee ever needs to survive restarts.
export class PreviewStore {
  #previewUrls = new Map();
  #pendingPRs = new Map();
  #waitingComments = new Map();
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

  markPending(prNumber, info) {
    this.#pendingPRs.set(prNumber, info);
  }

  isPending(prNumber) {
    return this.#pendingPRs.has(prNumber);
  }

  // Removes the pending entry and returns whether one existed.
  takePending(prNumber) {
    return this.#pendingPRs.delete(prNumber);
  }

  setWaitingComment(prNumber, commentId) {
    this.#waitingComments.set(prNumber, commentId);
  }

  // Removes and returns the placeholder comment id, or undefined if none.
  takeWaitingComment(prNumber) {
    const commentId = this.#waitingComments.get(prNumber);
    this.#waitingComments.delete(prNumber);
    return commentId;
  }

  hasSeen(key) {
    return this.#seen.has(key);
  }

  markSeen(key) {
    this.#seen.add(key);
  }
}
