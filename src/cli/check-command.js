import { dirname } from 'node:path';
import { loadLocalConfig } from '../config/local-config.js';
import { InvalidTarget } from '../core/target.js';
import { siteFromArgument, siteFromConfig, withSites } from '../serve/index.js';
import { EXIT, UsageError } from './audit-command.js';
import { renderCheck } from './render.js';

// `kanso discover --check`: the states a project declares, replayed against
// the page (src/discover/check.js) and reported as they are. Nothing is
// explored — finding states is the job of whoever has the page's source, the
// coding agent that wrote it — and this is what tells that agent, or a CI job,
// whether what was proposed holds: each state reached, changing something,
// ending where no other ends, closing by its `close:`.
//
// The states are the ones an audit goes through: `config.states`, the
// project's own `.kanso.yml` and the file `kanso discover --write` keeps
// combined (src/config/local-config.js), read the same way, `--config`
// included. Without one there is nothing to check, and that is said as a
// command that could not run — a check that passed on no state at all would
// read as a page verified.
//
// The exit code is the verdict, as an audit's is: 0 every state holds, 1 the
// check ran and something does not (`summary.ok`, which leaves ambiguous
// selectors and waits for nothing as warnings), 2 it could not run.
//
// `check` is injected for the tests; by default it is src/discover/check.js.
export async function runCheckCommand({ target = null, configPath = null, json = false, formFactors, cwd, io, check }) {
  const named = target == null ? null : usage(() => siteFromArgument(target, 'target', cwd));
  const { config, source } = loadLocalConfig({ cwd, configPath });
  const page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
  if (!page) throw new UsageError('discover --check needs a URL or a directory, or a serve: block in .kanso.yml saying how to serve the project');

  const states = config.states ?? [];
  if (states.length === 0) {
    throw new Error('no states declared to check: propose some under states: in .kanso.yml, or find them with `kanso discover --write`');
  }
  if (!json && source) io.stderr.write(`using ${source}\n`);
  if (!json && page.command) io.stderr.write(`starting ${page.command}\n`);

  const run = check ?? (await import('../discover/check.js')).checkStates;
  const progress = ticker(io);
  let result;
  try {
    result = await withSites({ page }, ({ url }) => run(url, states, { formFactors, onProgress: progress.state }));
  } finally {
    progress.stop();
  }

  if (json) io.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else io.stdout.write(renderCheck(result, { color: Boolean(io.stdout.isTTY) }));
  return result.summary.ok ? EXIT.ok : EXIT.failed;
}

// A check takes about as long as a click-through per state; each state said
// as it is replayed keeps that from reading as a hung command. On a terminal
// only, and never in the way of --json's stdout.
function ticker(io) {
  if (!io.stderr.isTTY) return { state() {}, stop() {} };
  return {
    state({ formFactor, state, done, total }) {
      io.stderr.write(`\r\x1b[Kchecking… ${formFactor} ${done}/${total}: ${state}`);
    },
    stop() {
      io.stderr.write('\r\x1b[K');
    },
  };
}

function usage(parse) {
  try {
    return parse();
  } catch (err) {
    if (err instanceof InvalidTarget) throw new UsageError(err.message);
    throw err;
  }
}
