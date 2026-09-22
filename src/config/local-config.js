import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStaticConfig } from './static-config.js';
import { parseRepoConfig } from './repo-config.js';
import { parseStates } from './states.js';

// The defaults ship with Kanso, so they resolve against this file rather than
// the directory the developer happens to be standing in.
const DEFAULTS_PATH = fileURLToPath(new URL('../../config.yml', import.meta.url));

// Resolves the configuration for a local run: Kanso's defaults, with the
// project's .kanso.yml layered on top when there is one. The same file the PR
// surface reads, so a local run and a CI run judge a page identically — and the
// same file for every local surface, the CLI and the MCP server alike.
//
// Nothing here touches src/config/env.js: that validates the GitHub App
// credentials the server needs and throws without them, which would make the
// CLI unusable for the developer it is meant for.
export function loadLocalConfig({ cwd = process.cwd(), configPath = null } = {}) {
  const defaults = loadStaticConfig(DEFAULTS_PATH);
  const path = configPath ? resolve(cwd, configPath) : join(cwd, '.kanso.yml');

  if (!existsSync(path)) {
    // An explicitly named file that is not there is a mistake worth reporting;
    // the absence of the conventional one is just an unconfigured project.
    if (configPath) throw new Error(`configuration file not found: ${path}`);
    return { config: defaults, source: null };
  }

  const config = parseRepoConfig(readFileSync(path, 'utf8'), defaults);
  // A state the file got wrong fails here, before a page is loaded, rather
  // than as a load that failed on every form factor.
  try {
    parseStates(config.states);
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
  return { config, source: path };
}
