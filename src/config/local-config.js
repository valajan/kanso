import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';
import { loadStaticConfig } from './static-config.js';
import { parseRepoConfig } from './repo-config.js';
import { combineStates, parseStates } from './states.js';

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
//
// The states `kanso discover` found are read too, from the file it writes
// beside the configuration (`statesFile`: .kanso/states.yml, whether it is
// there or not), and `config.states` is those and the project's own as one
// list (src/config/states.js, `combineStates`).
//
// `generated: false` leaves that file out, for the command that writes it.
export function loadLocalConfig({ cwd = process.cwd(), configPath = null, generated: withGenerated = true } = {}) {
  const defaults = loadStaticConfig(DEFAULTS_PATH);
  const path = configPath ? resolve(cwd, configPath) : join(cwd, '.kanso.yml');

  const exists = existsSync(path);
  // An explicitly named file that is not there is a mistake worth reporting;
  // the absence of the conventional one is just an unconfigured project.
  if (!exists && configPath) throw new Error(`configuration file not found: ${path}`);
  const config = exists ? parseRepoConfig(readFileSync(path, 'utf8'), defaults) : { ...defaults };
  const source = exists ? path : null;
  const statesFile = generatedStatesPath(source ? dirname(source) : cwd);

  // A state either file got wrong fails here, before a page is loaded, rather
  // than as a load that failed on every form factor.
  const declared = readStates(() => config.states, path);
  const generated = withGenerated && existsSync(statesFile)
    ? readStates(() => yaml.load(readFileSync(statesFile, 'utf8'))?.states, statesFile).map((state) => ({ ...state, generated: true }))
    : [];
  try {
    config.states = combineStates(declared, generated);
  } catch (err) {
    throw new Error(`${statesFile}: ${err.message}`);
  }
  return { config, source, statesFile };
}

// Where `kanso discover --write` keeps the states it found, for the project
// whose configuration is in `dir`: a file of their own, written whole each
// time, beside the one the project writes by hand.
export function generatedStatesPath(dir) {
  return join(dir, '.kanso', 'states.yml');
}

function readStates(read, path) {
  try {
    return parseStates(read());
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}
