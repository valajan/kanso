// AWS Amplify reports preview deployments through the `check_run` event, with
// the preview URL (*.amplifyapp.com) in `details_url`. resolve() returns null
// when the check_run is not Amplify's so the dispatcher can fall through.
//
// Note: Amplify only creates PR previews for private GitHub repositories.
export default {
  name: 'amplify',
  event: 'check_run',

  async resolve(payload, { store, log }) {
    const checkRun = payload.check_run;
    const appName = (checkRun?.app?.name ?? '').toLowerCase();
    const checkName = (checkRun?.name ?? '').toLowerCase();
    if (!checkName.includes('amplify') && !appName.includes('amplify')) return null;

    if (checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
      return { ignored: { ok: true, ignored_conclusion: checkRun.conclusion } };
    }

    const dedupKey = `checkrun:${checkRun.id}`;
    if (store.hasSeen(dedupKey)) {
      return { ignored: { ok: true, ignored: 'duplicate check_run' } };
    }
    store.markSeen(dedupKey);

    const targetUrl = checkRun.details_url;
    if (!targetUrl?.includes('.amplifyapp.com')) {
      log.warn('AWS Amplify check_run: no .amplifyapp.com URL found in details_url');
      return { ignored: { ok: true, ignored: 'no amplify preview URL in check_run details_url' } };
    }

    return { preview: { sha: checkRun.head_sha, targetUrl, source: 'AWS Amplify' } };
  },
};
