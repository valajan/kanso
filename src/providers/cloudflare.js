// Extracts a Cloudflare preview URL (*.pages.dev or *.workers.dev) from a
// check_run summary.
function extractCloudflarePreviewUrl(summary) {
  const match = (summary ?? '').match(/https:\/\/[^\s)>\]"']+\.(?:pages|workers)\.dev\b[^\s)>\]"']*/);
  return match?.[0] ?? null;
}

// Cloudflare Pages reports preview deployments through the `check_run` event.
// resolve() returns null when the check_run is not Cloudflare's, so the
// dispatcher can fall through to the next check_run provider.
export default {
  name: 'cloudflare',
  event: 'check_run',

  async resolve(payload, { store, log }) {
    const checkRun = payload.check_run;
    const appName = (checkRun?.app?.name ?? '').toLowerCase();
    const appSlug = (checkRun?.app?.slug ?? '').toLowerCase();
    if (!appName.includes('cloudflare') && !appSlug.includes('cloudflare')) return null;

    if (checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
      return { ignored: { ok: true, ignored_conclusion: checkRun.conclusion } };
    }

    const dedupKey = `checkrun:${checkRun.id}`;
    if (store.hasSeen(dedupKey)) {
      return { ignored: { ok: true, ignored: 'duplicate check_run' } };
    }
    store.markSeen(dedupKey);

    const targetUrl = extractCloudflarePreviewUrl(checkRun.output?.summary);
    if (!targetUrl) {
      log.warn('Cloudflare Pages check_run: no preview URL (.pages.dev / .workers.dev) found in summary');
      return { ignored: { ok: true, ignored: 'no cloudflare preview URL in check_run summary' } };
    }

    return { preview: { sha: checkRun.head_sha, targetUrl, source: 'Cloudflare Pages' } };
  },
};
