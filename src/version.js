import { readFileSync } from 'node:fs';

// Kanso's version, read from the manifest rather than restated here, so
// `kanso --version` and the version an MCP host displays can never disagree.
export function version() {
  const path = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')).version;
}
