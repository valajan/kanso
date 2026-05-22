import { readFileSync } from 'node:fs';

// Reads and validates the process environment, failing fast if a required
// variable is missing. The GitHub App private key is read eagerly here so a
// bad path surfaces at startup rather than on the first webhook.
export function loadEnv() {
  const appId = process.env.GITHUB_APP_ID;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !webhookSecret || !privateKeyPath) {
    throw new Error('Missing env vars: GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET, GITHUB_PRIVATE_KEY_PATH');
  }

  return {
    appId,
    webhookSecret,
    privateKeyPath,
    privateKey: readFileSync(privateKeyPath, 'utf8'),
    port: Number(process.env.PORT ?? 3000),
  };
}
