import yaml from 'js-yaml';

// Deep-merges a repo override on top of the static defaults.
// budgets keys are merged individually so a client can override just one metric.
export function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    budgets: { ...(base.budgets ?? {}), ...(override.budgets ?? {}) },
  };
}

// Fetches .kanso.yml from the client repo and merges it with staticConfig.
// Falls back to staticConfig silently if the file is absent or unreadable.
export async function loadRepoConfig({ octokit, owner, repo, staticConfig, ref, log }) {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner, repo, path: '.kanso.yml', ...(ref ? { ref } : {}) }
    );
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const repoConfig = yaml.load(content) ?? {};
    return mergeConfig(staticConfig, repoConfig);
  } catch (err) {
    if (err.status === 404) return staticConfig;
    // 403 = app lacks Contents read permission; fall back rather than crashing
    if (err.status === 403) {
      log?.warn(`${owner}/${repo} — no Contents permission, using default config`);
      return staticConfig;
    }
    throw err;
  }
}
