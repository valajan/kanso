import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

// Loads the static fallback configuration (config.yml). Repo-level overrides
// from a .perfguard.yml are layered on top later — see config/repo-config.js.
export function loadStaticConfig(path = './config.yml') {
  const config = yaml.load(readFileSync(path, 'utf8'));
  if (!config?.base_url) throw new Error('Missing config: base_url');
  return config;
}
