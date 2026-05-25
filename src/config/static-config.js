import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

// Loads the static fallback configuration (config.yml). Repo-level overrides
// from a .kanso.yml are layered on top later — see config/repo-config.js.
export function loadStaticConfig(path = './config.yml') {
  return yaml.load(readFileSync(path, 'utf8'));
}
