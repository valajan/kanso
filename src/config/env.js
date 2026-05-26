import { readFileSync } from 'node:fs';

// Reads and validates the process environment, failing fast if a required
// variable is missing. The GitHub App private key is read eagerly here so a
// bad path surfaces at startup rather than on the first webhook.
//
// Accepts the private key either as a raw PEM string (GITHUB_PRIVATE_KEY, for
// cloud deployments where file mounts aren't available) or as a file path
// (GITHUB_PRIVATE_KEY_PATH, for local dev). GITHUB_PRIVATE_KEY takes precedence.
export function loadEnv() {
  const appId = process.env.GITHUB_APP_ID;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const privateKeyRaw = process.env.GITHUB_PRIVATE_KEY;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !webhookSecret || (!privateKeyRaw && !privateKeyPath)) {
    throw new Error('Missing env vars: GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET, and one of GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH');
  }

  const privateKey = privateKeyRaw
    ? privateKeyRaw.replace(/\\n/g, '\n')
    : readFileSync(privateKeyPath, 'utf8');

  return {
    appId,
    webhookSecret,
    privateKeyPath,
    privateKey,
    port: Number(process.env.PORT ?? 3000),
  };
}
