import { detectSource } from './detect-source.js';

// Netlify reports preview deployments through the commit `status` event.
// We only act on Netlify-originated statuses; other status providers (CI, etc.)
// are ignored here.
export default {
  name: 'netlify',
  event: 'status',

  async resolve(payload) {
    const context = payload.context ?? '';
    if (!context.toLowerCase().includes('netlify')) {
      return { ignored: { ok: true, ignored: 'status not from netlify' } };
    }

    const state = payload.state;
    const targetUrl = payload.target_url;
    const sha = payload.sha;
    if (state !== 'success' || !targetUrl || !sha) {
      return { ignored: { ok: true, ignored_state: state } };
    }

    return { preview: { sha, targetUrl, source: detectSource(context, targetUrl) } };
  },
};
