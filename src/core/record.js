import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderViewer, viewerData } from './viewer.js';

// What a record holds: one journal per load, named by src/probes/journal.js
// and written by the worker that ran it, with its frames under `frames/`; the
// result; and the page that shows them all, `index.html`, which opens from the
// disk with nothing beside it (src/core/viewer.js). The CLI and the MCP server
// keep one the same way.
export const RECORD_RESULT = 'audit.json';
const RECORD_VIEWER = 'index.html';
const RECORD_FRAMES = 'frames';
const RECORD_JOURNAL = /^(current|baseline)\.(mobile|desktop)\.(\d+)\.jsonl$/;

// A record directory kept from an earlier audit loses what that audit wrote —
// a third run's journal would otherwise sit beside a one-run audit's — and
// nothing else in it.
export function clearRecord(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name === RECORD_RESULT || name === RECORD_VIEWER || RECORD_JOURNAL.test(name)) rmSync(join(dir, name));
    if (name === RECORD_FRAMES) rmSync(join(dir, name), { recursive: true, force: true });
  }
}

// Writes the result beside the journals the loads left, then the page that
// shows them. Returns the page's path.
export function writeRecord(dir, result) {
  writeFileSync(join(dir, RECORD_RESULT), JSON.stringify(result, null, 2) + '\n');
  const { loads, frames } = readJournals(dir);
  const page = join(dir, RECORD_VIEWER);
  writeFileSync(page, renderViewer(viewerData({ result, loads, frames })));
  return page;
}

// Every journal in `dir`, the page under audit first, mobile before desktop,
// run by run — and every frame they name, as a data URI. A line that is not
// JSON, from a load cut short as it wrote, is left out; a frame that is not
// there is left out too, and the viewer says so where it would have been.
export function readJournals(dir) {
  const order = { current: 0, baseline: 1, mobile: 0, desktop: 1 };
  const loads = readdirSync(dir)
    .map((name) => ({ name, match: RECORD_JOURNAL.exec(name) }))
    .filter(({ match }) => match)
    .map(({ name, match: [, side, formFactor, run] }) => ({ name, side, formFactor, run: Number(run), events: readEvents(join(dir, name)) }))
    .sort((a, b) => order[a.side] - order[b.side] || order[a.formFactor] - order[b.formFactor] || a.run - b.run);

  const frames = {};
  for (const { events } of loads) {
    for (const { frame } of events) {
      if (!frame?.file || frames[frame.file]) continue;
      const path = join(dir, frame.file);
      if (existsSync(path)) frames[frame.file] = `data:image/jpeg;base64,${readFileSync(path).toString('base64')}`;
    }
  }
  return { loads, frames };
}

function readEvents(path) {
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}
