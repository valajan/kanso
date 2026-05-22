import { detectSource } from './detect-source.js';

// Vercel and Render (and any turnkey host using the GitHub Deployments API)
// surface preview URLs through the `deployment_status` event.
//
// Railway also emits deployment_status events, but its target URL points at the
// Railway dashboard rather than the preview — Railway previews are picked up
// from the bot's PR comment instead (see providers/railway.js).
export default {
  name: 'deployment-status',
  event: 'deployment_status',

  async resolve(payload) {
    const deploymentStatus = payload.deployment_status;
    const state = deploymentStatus?.state;
    const targetUrl = deploymentStatus?.environment_url || deploymentStatus?.target_url;
    const sha = payload.deployment?.sha;
    const context = payload.deployment?.environment ?? '';

    if (state !== 'success' || !targetUrl || !sha) {
      return { ignored: { ok: true, ignored_state: state } };
    }
    if (targetUrl.includes('railway.com')) {
      return {
        ignored: { ok: true, ignored: 'railway deployment_status (target is dashboard, not preview)' },
      };
    }

    return { preview: { sha, targetUrl, source: detectSource(context, targetUrl) } };
  },
};
