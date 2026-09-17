import yaml from 'js-yaml';

// Upper bound on a caller-supplied .kanso.yml. Real config files are a few
// hundred bytes; anything larger is a mistake or an attempt to make the YAML
// parser do expensive work.
const MAX_CONFIG_BYTES = 64 * 1024;

// Deep-merges a repo override on top of the static defaults.
// budgets keys are merged individually so a client can override just one metric.
export function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    budgets: { ...(base.budgets ?? {}), ...(override.budgets ?? {}) },
  };
}

// Parses a .kanso.yml document. js-yaml's `load` uses the core schema, which
// builds only plain data — no custom tags, no code execution — so a config
// pushed by a caller can be parsed safely. It still only ever affects that
// caller's own report.
export function parseRepoConfig(text, staticConfig) {
  if (typeof text !== 'string' || text.length === 0) return staticConfig;
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error(`.kanso.yml exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  const parsed = yaml.load(text);
  if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('.kanso.yml must be a YAML mapping');
  }
  return mergeConfig(staticConfig, parsed ?? {});
}

// Resolves the effective config for a repo.
//
// `inlineConfig` is the file content sent alongside a /v1/audit request: the CI
// job already has the repo checked out, so it can read .kanso.yml itself and
// save Kanso a round-trip — and a token with no Contents scope still works.
// Without it, the file is fetched through the forge; an absent or unreadable
// file falls back to the static defaults.
export async function loadRepoConfig({ forge, staticConfig, ref, log, inlineConfig }) {
  if (inlineConfig != null) {
    try {
      return parseRepoConfig(inlineConfig, staticConfig);
    } catch (err) {
      log?.warn?.(`${forge?.slug ?? 'repo'} — invalid .kanso.yml supplied, using defaults: ${err.message}`);
      return staticConfig;
    }
  }

  const content = await forge.getFileContent({ path: '.kanso.yml', ref });
  if (content == null) return staticConfig;
  try {
    return parseRepoConfig(content, staticConfig);
  } catch (err) {
    log?.warn?.(`${forge.slug} — invalid .kanso.yml in repo, using defaults: ${err.message}`);
    return staticConfig;
  }
}
