import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadLocalConfig } from '../config/local-config.js';
import { InvalidTarget } from '../core/target.js';
import { siteFromArgument, siteFromConfig, withSites } from '../serve/index.js';
import { EXIT, UsageError } from './audit-command.js';

// `kanso discover`: the states of a page found by clicking through it
// (src/discover/), written as the `states:` of the project's .kanso.yml — so
// that the checks that go through states have some to go through without
// anyone writing them.
//
// The states the file already declares are kept as they are, first; a state
// found that one of them already reaches is not added again. Without
// `--write`, the block that would be written is printed, and nothing is
// touched: what a click-through found is worth reading before an audit
// depends on it.
//
// `discover` is injected for the tests; by default it is src/discover/.
export async function runDiscoverCommand({ target = null, configPath = null, write = false, json = false, maxDepth, maxClicks, formFactors, cwd, io, discover }) {
  const named = target == null ? null : usage(() => siteFromArgument(target, 'target', cwd));
  const { config, source } = loadLocalConfig({ cwd, configPath });
  const page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
  if (!page) throw new UsageError('discover needs a URL or a directory, or a serve: block in .kanso.yml saying how to serve the project');
  if (!json && source) io.stderr.write(`using ${source}\n`);
  if (!json && page.command) io.stderr.write(`starting ${page.command}\n`);

  const { statesFrom, mergeStates, renderStates, writeStates } = await import('../discover/states.js');
  const find = discover ?? (await import('../discover/index.js')).discover;

  const progress = ticker(io, json);
  let found;
  try {
    found = await withSites({ page }, ({ url }) => find(url, { formFactors, maxDepth, maxClicks, onProgress: progress.click }));
  } finally {
    progress.stop();
  }

  const existing = Array.isArray(config.states) ? config.states : [];
  const discovered = statesFrom(found.explored, { taken: existing.map((state) => state?.name).filter(Boolean) });
  const { states, added } = mergeStates(existing, discovered);

  if (json) {
    io.stdout.write(JSON.stringify({ ...found, states, added }, null, 2) + '\n');
  } else {
    io.stderr.write(summary(found, discovered, added));
  }

  if (write) {
    const path = source ?? (configPath ? resolve(cwd, configPath) : join(cwd, '.kanso.yml'));
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (added.length > 0) writeFileSync(path, writeStates(text, states));
    if (!json) io.stderr.write(added.length > 0 ? `wrote ${added.length} state${added.length === 1 ? '' : 's'} to ${relative(cwd, path) || path}\n` : 'nothing to add\n');
  } else if (!json && states.length > 0) {
    io.stdout.write(renderStates(states));
    if (added.length > 0) io.stderr.write('run again with --write to add them to .kanso.yml\n');
  }
  return EXIT.ok;
}

// What the click-through came to, for the terminal: what it found on each
// screen, what it left out and why, and whether it stopped short.
function summary({ explored, dropped, runs }, discovered, added) {
  const lines = [];
  for (const [formFactor, run] of Object.entries(runs)) {
    const states = explored[formFactor]?.length ?? 0;
    const short = run.outOfTime ? ', out of time' : run.leftInQueue > 0 ? `, ${run.leftInQueue} clicks left untried` : '';
    lines.push(`${formFactor}: ${states} state${states === 1 ? '' : 's'} from ${run.clicks} click${run.clicks === 1 ? '' : 's'}${short}`);
    if (!run.stable) lines.push(`  the page is not the same on two first visits: what moves on its own was left out of the comparison`);
  }
  for (const { formFactor, name, role, reason } of dropped) {
    lines.push(`left out on ${formFactor}: ${role} "${name}" — it did not replay (${reason})`);
  }
  lines.push(`${discovered.length} state${discovered.length === 1 ? '' : 's'} found, ${added.length} new`);
  return lines.join('\n') + '\n';
}

// A click-through takes a minute or more; each click said as it lands keeps
// that from reading as a hung command.
function ticker(io, json) {
  if (json || !io.stderr.isTTY) return { click() {}, stop() {} };
  let count = 0;
  return {
    click({ formFactor, click }) {
      count += 1;
      io.stderr.write(`\r\x1b[Kexploring… ${count} clicks — ${formFactor}: ${click.role} "${(click.name ?? '').slice(0, 40)}" ${click.outcome}`);
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
