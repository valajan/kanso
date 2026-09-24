import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
//
// An event can carry a frame: what the page looked like at that moment — the
// page loaded, a state reached, a transition's way in and out — for a viewer to
// show it, and to draw over it the boxes the events after it name (a focus
// reading's `rect`). `frame` is { file, width, height, scale }: the viewport in
// CSS pixels, which the boxes are in, and the device pixels to one of them,
// which the picture is in. Kept in memory until the journal is written, then
// as JPEG files of their own under `frames/<journal>/` beside it — `file` is
// the path from the journal's directory —, so that the journal itself still
// reads in a text editor. A frame is taken through a view's `shot`, never on
// its own; NO_JOURNAL's takes none, so a load nobody records pays nothing for
// them.
export const SCHEMA = 1;

// A frame is a screenshot, some tens of kilobytes: enough to see what a
// finding is about, not to archive the page. A load takes MAX_FRAMES at most;
// the moments after that are logged without one.
const FRAME_QUALITY = 60;
const MAX_FRAMES = 40;
// A screenshot that does not come is a missing frame, not a stuck probe.
const SHOT_TIMEOUT_MS = 5_000;

export class Journal {
  #events = [];
  #frames = new Map();
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

  // Logs the event with a frame of `page` as it is now — the viewport, as a
  // visitor sees it. A frame that cannot be taken, or one past MAX_FRAMES,
  // leaves the event without one.
  async shot(page, kind, data = {}) {
    const frame = this.#frames.size < MAX_FRAMES ? await takeFrame(page).catch(() => null) : null;
    if (!frame) return this.log(kind, data);
    const file = `${this.#events.length}.jpg`;
    this.#frames.set(file, frame.jpeg);
    this.log(kind, { ...data, frame: { file, ...frame.size } });
  }

  // The same journal, every event it takes carrying `context` too.
  with(context) {
    return view(this, context);
  }

  get events() {
    return this.#events;
  }

  // The frames taken so far, as JPEG bytes by the `file` their event names.
  get frames() {
    return this.#frames;
  }

  // Writes every event so far to `path`, one per line, and its frames under
  // `frames/<journal>/` beside it — the events naming them by that path.
  write(path) {
    const dir = dirname(path);
    const frames = join('frames', basename(path, '.jsonl'));
    mkdirSync(dir, { recursive: true });
    if (this.#frames.size > 0) mkdirSync(join(dir, frames), { recursive: true });
    for (const [file, jpeg] of this.#frames) writeFileSync(join(dir, frames, file), jpeg);
    const line = (event) => JSON.stringify(event.frame ? { ...event, frame: { ...event.frame, file: `${frames}/${event.frame.file}` } } : event);
    writeFileSync(path, this.#events.map(line).join('\n') + '\n');
  }
}

// A view: the journal, every event carrying `context`. One made `withoutFrames`
// logs what it is asked to shoot, and takes no frame — for a probe that
// measures, whose timing a screenshot would skew.
function view(journal, context, frames = true) {
  return {
    log: (kind, data = {}) => journal.log(kind, { ...context, ...data }),
    shot: async (page, kind, data = {}) => (frames ? journal.shot(page, kind, { ...context, ...data }) : journal.log(kind, { ...context, ...data })),
    with: (more) => view(journal, { ...context, ...more }, frames),
    withoutFrames: () => view(journal, context, false),
  };
}

export const NO_JOURNAL = {
  log() {},
  async shot() {},
  with() {
    return NO_JOURNAL;
  },
  withoutFrames() {
    return NO_JOURNAL;
  },
};

// The viewport as it shows now, as a JPEG, with its size in CSS pixels and
// the device pixels to each. The size is the visual viewport's, which is what
// the picture covers: a phone page wider than the phone is shown zoomed out,
// more CSS pixels to the screen than the screen is wide.
async function takeFrame(page) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('no frame')), SHOT_TIMEOUT_MS);
  });
  try {
    const [jpeg, size] = await Promise.race([
      Promise.all([
        page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY }),
        page.evaluate('({ width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight, scale: devicePixelRatio })'),
      ]),
      timeout,
    ]);
    return { jpeg: Buffer.from(jpeg), size };
  } finally {
    clearTimeout(timer);
  }
}

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
