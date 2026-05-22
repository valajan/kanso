import { createHmac, timingSafeEqual } from 'node:crypto';

// Builds a webhook signature verifier bound to a secret. The returned function
// validates GitHub's X-Hub-Signature-256 header against the raw request body
// using a constant-time comparison.
export function createSignatureVerifier(secret) {
  return function verifySignature(rawBody, signatureHeader) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const received = Buffer.from(signatureHeader);
    const computed = Buffer.from(expected);
    if (received.length !== computed.length) return false;
    return timingSafeEqual(received, computed);
  };
}
