import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// What the probes did, step by step, for whoever wants to see it: the page
// loaded, each state reached or not, each Tab stop, each finding — one event a
// line, in a file of its own per page load (JSON Lines). One file reads in a
// text editor; a thousand read with jq or DuckDB as one table.
//
// The runner writes what every probe goes through (src/probes/index.js); a
// probe adds what only it knows through the `log` it is handed. A finding is
// logged with its rule, its state and the path of each element, which is what
// ties a line of the report to the moment that produced it.
//
// Off unless asked for: NO_JOURNAL takes every call and keeps nothing, so a
// probe logs without asking whether anyone listens.
//
// Every event is { seq, t, kind, ...context, ...data }: `seq` its order in the
// load, `t` the milliseconds since the load began, `context` what the view it
// was logged through adds — the probe, the state.
export const SCHEMA = 1;

export class Journal {
  #events = [];
  #start;
  #now;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
    this.#start = now();
  }

  // `data` cannot overwrite what makes the event: its order, its time, its
  // kind.
  log(kind, data = {}) {
    this.#events.push({ ...data, seq: this.#events.length, t: this.#now() - this.#start, kind });
  }

  // The same journal, every event it takes carrying `context` too.
  with(context) {
    return view(this, context);
  }

  get events() {
    return this.#events;
  }

  // Writes every event so far to `path`, one per line.
  write(path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.#events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  }
}

function view(journal, context) {
  return {
    log: (kind, data = {}) => journal.log(kind, { ...context, ...data }),
    with: (more) => view(journal, { ...context, ...more }),
  };
}

export const NO_JOURNAL = {
  log() {},
  with() {
    return NO_JOURNAL;
  },
};

// A finding as the journal keeps it: enough to find it again in the report —
// its rule, its state, the elements by path — without the report itself.
export function findingEvent({ rule, at, impact, count, needsReview, nodes = [] }) {
  return {
    rule,
    ...(at ? { at } : {}),
    ...(impact ? { impact } : {}),
    count,
    ...(needsReview ? { needsReview } : {}),
    nodes: nodes.map(({ path, selector, explanation }) => ({ path, selector, ...(explanation ? { explanation } : {}) })),
  };
}

// Where one load's journal goes, inside the directory a record is kept in:
// which page, which screen, which of its runs.
export function journalPath(dir, { side, formFactor, run }) {
  return join(dir, `${side}.${formFactor}.${run}.jsonl`);
}
