import { existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { InvalidTarget, parseTarget } from '../core/target.js';
import { startCommand, ServeError } from './command.js';
import { serveDirectory } from './static.js';

export { ServeError };

// What the local surfaces — the CLI and the MCP server — can be pointed at: a
// page something else serves, a directory of built files Kanso serves itself,
// or the command that serves the project, which Kanso starts and stops. The
// core only ever sees a URL; how that URL came to answer is decided here.
//
// A site is described before it is opened, so a mistake in the description is
// reported before anything starts:
//
//   { url }                     a page already served
//   { dir, name }               a directory to serve; `name` is how to call it
//   { command, url, cwd }       a command that serves the project at `url`
//
// The server path never comes here. /v1/audit audits a URL a CI job deployed,
// and a .kanso.yml read from a pull request must never get a command run.

// Reads what a user named on the command line or in a tool call. Anything with
// a scheme is a URL, and is held to the rules of one; anything else is a path.
// Either way a mistake is the caller's, and each surface reports it as such.
export function siteFromArgument(value, label, cwd) {
  if (value.includes('://')) return { url: parseTarget(value, label) };

  const dir = resolve(cwd, value);
  if (!isDirectory(dir)) throw new InvalidTarget(`${label} is neither a URL nor a directory: ${value}`);
  return { dir, name: value };
}

// Reads the `serve:` block of a .kanso.yml — how to serve the project when no
// page is named. Paths and the command resolve against the directory of the
// file that says them, so a --config pointing into a subproject means that
// subproject; `cwd` is only where a directory is named from in a report.
// Returns null when the project says nothing.
//
//   serve:                        serve:
//     dir: dist                     command: npm run preview
//                                   url: http://localhost:4173
export function siteFromConfig(serve, { configDir, cwd }) {
  if (serve == null) return null;
  if (typeof serve !== 'object' || Array.isArray(serve)) throw new ServeError(SERVE_SHAPE);

  const { dir, command, url } = serve;
  if (dir != null) {
    if (command != null || url != null) throw new ServeError(`serve: takes dir, or command and url — not both. ${SERVE_SHAPE}`);
    if (typeof dir !== 'string' || dir === '') throw new ServeError('serve.dir must be a path');
    const path = resolve(configDir, dir);
    return { dir: path, name: relative(cwd, path) || '.' };
  }
  if (command != null) {
    if (typeof command !== 'string' || command.trim() === '') throw new ServeError('serve.command must be a command line');
    if (url == null) throw new ServeError('serve.command needs serve.url: the address the command serves the project at');
    if (typeof url !== 'string') throw new ServeError('serve.url must be a URL');
    return { command, url: config(() => parseTarget(url, 'serve.url')), cwd: configDir };
  }
  if (url != null) {
    throw new ServeError('serve.url needs serve.command: Kanso serves what it can start and stop. To audit a page served elsewhere, name its URL');
  }
  throw new ServeError(SERVE_SHAPE);
}

const SERVE_SHAPE = 'serve: needs either dir (a directory of built files) or command and url (what serves the project, and where)';

// Makes a site answer, and returns its URL and how to stop it. `served` is
// what the audit result says of it: nothing for a URL someone else serves, the
// directory or the command otherwise.
export async function openSite(site) {
  if (site.url && !site.command) return { url: site.url, served: null, close: async () => {} };

  if (site.dir) {
    if (!isDirectory(site.dir)) throw new ServeError(`there is no ${site.name} directory to serve — build the project first`);
    if (!existsSync(join(site.dir, 'index.html'))) {
      throw new ServeError(`${site.name} has no index.html — is it the output of the build?`);
    }
    const server = await serveDirectory(site.dir);
    return { url: server.url, served: { dir: site.name }, close: server.close };
  }

  const server = await startCommand({ command: site.command, url: site.url, cwd: site.cwd });
  return { url: server.url, served: { command: site.command }, close: server.close };
}

// Opens the page and its baseline, hands their URLs to `run`, and stops
// whatever was started once it is done — or failed, or threw.
export async function withSites({ page, baseline = null }, run) {
  const opened = [];
  try {
    const current = await openSite(page);
    opened.push(current);
    const reference = baseline ? await openSite(baseline) : null;
    if (reference) opened.push(reference);

    const served = {};
    if (current.served) served.url = current.served;
    if (reference?.served) served.baseline = reference.served;

    return await run({
      url: current.url,
      baseline: reference?.url ?? null,
      served: Object.keys(served).length > 0 ? served : null,
    });
  } finally {
    await Promise.all(opened.map((site) => site.close()));
  }
}

// How a site reads in a report: the directory or the command someone would
// recognise, rather than the port it happened to be served on.
export function siteName(url, served) {
  if (served?.dir) return served.dir;
  if (served?.command) return `${url} (${served.command})`;
  return url;
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A URL in the configuration that is not one is a configuration mistake.
function config(parse) {
  try {
    return parse();
  } catch (err) {
    throw new ServeError(err.message);
  }
}
