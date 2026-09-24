import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import yaml from 'js-yaml';
import { loadLocalConfig } from '../config/local-config.js';
import { renderStatesFile, stateNames, statesFrom } from '../discover/states.js';
import { InvalidTarget } from '../core/target.js';
import { siteFromArgument, siteFromConfig, withSites } from '../serve/index.js';
import { EXIT, UsageError } from './audit-command.js';

// `kanso discover`: the states of a page found by clicking through it
// (src/discover/), written as .kanso/states.yml beside the project's
// .kanso.yml — so that the checks that go through states have some to go
// through without anyone writing them.
//
// The file is the command's alone: written whole every time, like a lock file,
// never merged with what is there, and the project's .kanso.yml is never
// touched. A state the project wrote by hand stays in .kanso.yml, and is
// combined with the found ones when the configuration loads, winning over a
// found state reached the same way (src/config/local-config.js). A found state
// takes none of the hand-written states' names. Without `--write`, the file
// that would be written is printed, and nothing is touched: what a
// click-through found is worth reading before an audit depends on it.
//
// `discover` is injected for the tests; by default it is src/discover/.
export async function runDiscoverCommand({ target = null, configPath = null, write = false, json = false, maxDepth, maxClicks, formFactors, cwd, io, discover }) {
  const named = target == null ? null : usage(() => siteFromArgument(target, 'target', cwd));
  // Without the file it is about to write: a file gone wrong must not stand
  // in the way of the command that writes it again.
  const { config, source, statesFile } = loadLocalConfig({ cwd, configPath, generated: false });
  const page = named ?? siteFromConfig(config.serve, { configDir: source && dirname(source), cwd });
  if (!page) throw new UsageError('discover needs a URL or a directory, or a serve: block in .kanso.yml saying how to serve the project');
  if (!json && source) io.stderr.write(`using ${source}\n`);
  if (!json && page.command) io.stderr.write(`starting ${page.command}\n`);

  const find = discover ?? (await import('../discover/index.js')).discover;

  const progress = ticker(io, json);
  let found;
  try {
    found = await withSites({ page }, ({ url }) => find(url, { formFactors, maxDepth, maxClicks, onProgress: progress.click }));
  } finally {
    progress.stop();
  }

  const handWritten = (config.states ?? []).filter((state) => !state.generated).map((state) => state.name);
  const states = statesFrom(found.explored, { taken: handWritten });
  const text = renderStatesFile(states);
  const shown = relative(cwd, statesFile) || statesFile;

  if (json) io.stdout.write(JSON.stringify({ ...found, states, statesFile }, null, 2) + '\n');
  else io.stderr.write(summary(found, stateNames(states).length));

  if (!write) {
    if (!json) {
      io.stdout.write(text);
      io.stderr.write(`run again with --write to write them to ${shown}\n`);
    }
    return EXIT.ok;
  }

  const before = existsSync(statesFile) ? readFileSync(statesFile, 'utf8') : null;
  if (before === text) {
    if (!json) io.stderr.write(`${shown} unchanged\n`);
    return EXIT.ok;
  }
  mkdirSync(dirname(statesFile), { recursive: true });
  writeFileSync(statesFile, text);
  if (!json) io.stderr.write(changes(shown, before == null ? [] : namesIn(before), stateNames(states)));
  return EXIT.ok;
}

// The names a generated file held. One that no longer reads is replaced whole
// like any other, and what it held is taken as nothing: the file is the
// command's, and a hand that broke it has nothing in it to keep.
function namesIn(text) {
  try {
    return stateNames(yaml.load(text)?.states);
  } catch {
    return [];
  }
}

// What a write changed, by name: the states the file now has that it did not,
// and those it had and no longer has.
function changes(shown, before, after) {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  const lines = [`wrote ${shown}`];
  if (added.length > 0) lines.push(`  added: ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`  removed: ${removed.join(', ')}`);
  return lines.join('\n') + '\n';
}

// What the click-through came to, for the terminal: what it found on each
// screen, what it left out and why, and whether it stopped short.
function summary({ explored, dropped, runs }, count) {
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
  lines.push(`${count} state${count === 1 ? '' : 's'} found`);
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
