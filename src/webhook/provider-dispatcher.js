import { providersForEvent, noMatchResponse } from '../providers/index.js';

const MISSING_INSTALLATION = 'MISSING_INSTALLATION';

// Routes a preview-related webhook event through the registered providers.
//
// Providers for the event are tried in order: the first to return a non-null
// result wins. An `ignored` result is returned verbatim as the HTTP body; a
// `preview` result triggers the report pipeline. If no provider claims the
// event, the event's no-match response is returned.
//
// Returns { code?, body }: `code` is set only for the 400 emitted when the
// webhook lacks an installation id.
export async function dispatchProviderEvent({ event, payload, githubApp, store, handlePreviewUrl, log }) {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  // Lazily creates and memoizes the installation client. The installation id is
  // only required once an event is actually actionable, so this is resolved
  // after the provider's ignore checks — and synchronously throws a tagged
  // error when the id is absent.
  let octokitPromise = null;
  const getOctokit = () => {
    if (octokitPromise) return octokitPromise;
    const installationId = payload.installation?.id;
    if (!installationId) {
      const err = new Error('missing installation id');
      err.code = MISSING_INSTALLATION;
      throw err;
    }
    octokitPromise = githubApp.getInstallationOctokit(installationId);
    return octokitPromise;
  };

  const ctx = { getOctokit, owner, repo, store, log };

  let resolution = null;
  try {
    for (const provider of providersForEvent(event)) {
      const result = await provider.resolve(payload, ctx);
      if (result != null) {
        resolution = result;
        break;
      }
    }

    if (resolution == null) return { body: noMatchResponse(event) };
    if (resolution.ignored) return { body: resolution.ignored };

    const octokit = await getOctokit();
    const { sha, targetUrl, source } = resolution.preview;
    const body = await handlePreviewUrl({ octokit, owner, repo, sha, targetUrl, source, log });
    return { body };
  } catch (err) {
    if (err.code === MISSING_INSTALLATION) {
      return { code: 400, body: { error: 'missing installation id' } };
    }
    throw err;
  }
}
