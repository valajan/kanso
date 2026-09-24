import { inPage } from '../../probes/dom.js';

// Interaction to Next Paint: how long the page takes to show that it heard a
// click — from the press, through the handlers it runs, to the frame that
// paints their result. The one Core Web Vital Lighthouse does not measure on a
// page load, for want of anyone clicking during one: its report stands TBT in
// for it.
//
// Kanso clicks. The interactions are the states the project declares
// (src/config/states.js) — the menu opened, the dialog shown — reached as axe
// reaches them, down each branch, in a page of the probe's own; the clicks
// made again to get back to where a branch starts are not timed twice. The
// CPU is
// slowed as Lighthouse slows it (src/probes/index.js): a click timed on the
// machine running the audit would say nothing of a phone. With no state
// declared there is nothing to time, and the probe does not run: INP is then
// not measured, which a report says, rather than 0 ms, which it would read as
// a page that answers at once.
//
// The page's INP is its slowest interaction — the rule while there are fewer
// than fifty, which a handful of declared clicks never reach. Each is timed as
// Chrome times it for the Event Timing API, and as the web-vitals library and
// CrUX read it: the longest of the events one press dispatches, pointerdown to
// click, in steps of 8 ms. Chrome reports only the ones over 16 ms, and always
// the page's first; a click that took less is left out, and cannot be the
// slowest anyway.
//
// A click that leads to another page takes its timing with it: what is read
// is the document the page is on when the state is reached.
export const inpProbe = {
  id: 'inp',
  rules: ['inp'],
  states: true,
  onlyInStates: true,
  measures: true,
  beforeLoad: watchInteractions,

  async run(page) {
    return (await inPage(page, takeInteractions)).map(({ latency, inputDelay, processing, presentation, ...rest }) => ({
      ...rest,
      latency: Math.round(latency),
      inputDelay: Math.round(inputDelay),
      processing: Math.round(processing),
      presentation: Math.round(presentation),
    }));
  },
};

// The slowest of the interactions a load timed, or null when it timed none.
export function slowestInteraction(interactions = []) {
  return interactions.reduce((slowest, interaction) => (
    slowest == null || interaction.latency > slowest.latency ? interaction : slowest
  ), null);
}

// What a report says of the INP of one load, beside the number: the slowest
// interaction, and where its time went; how many interactions were timed; the
// states that could not be reached, whose clicks nobody timed. null when the
// probe did not run — no state declared.
export function inpDiagnostics(probed) {
  if (!probed) return null;
  const interactions = probed.measures ?? [];
  return {
    interaction: slowestInteraction(interactions),
    count: interactions.length,
    failures: probed.failures.map(({ at, error }) => ({ ...(at ? { at } : {}), error })),
  };
}

// --- in the page ----------------------------------------------------------------

// Installed before any of the page's scripts, in the top frame: keeps the
// events each interaction dispatched — pointerdown, pointerup, click — until
// a reading takes them.
function watchInteractions() {
  if (window !== window.top) return;
  const byInteraction = new Map();

  const keep = (entry) => {
    // The first input is reported whatever its duration, and carries the id
    // of the interaction it began, when it began one.
    const id = entry.interactionId || (entry.entryType === 'first-input' ? 'first' : null);
    if (id == null) return;
    if (!byInteraction.has(id)) byInteraction.set(id, []);
    byInteraction.get(id).push(entry);
  };
  const observer = new PerformanceObserver((list) => list.getEntries().forEach(keep));
  observer.observe({ type: 'event', durationThreshold: 16, buffered: true });
  observer.observe({ type: 'first-input', buffered: true });

  window[Symbol.for('kanso.interactions')] = () => {
    observer.takeRecords().forEach(keep);
    const taken = [...byInteraction.values()];
    byInteraction.clear();
    return taken;
  };
}

// The interactions timed since the last reading. Each is its events taken
// together, as web-vitals takes them: its latency the longest of theirs, and
// three parts to it — waiting for the main thread, from the press to the first
// handler; running the handlers, to the end of the last; then laying out and
// painting what they changed. What it is and where it landed are the event
// whose handlers ran longest — the click, most of the time: a pointer event
// names no element.
function takeInteractions(dom) {
  const take = window[Symbol.for('kanso.interactions')];
  return (take ? take() : []).map((entries) => {
    const start = Math.min(...entries.map((entry) => entry.startTime));
    const processingStart = Math.min(...entries.map((entry) => entry.processingStart));
    const processingEnd = Math.max(...entries.map((entry) => entry.processingEnd));
    // A duration is rounded to 8 ms, and can come out shorter than the
    // handlers it includes.
    const latency = Math.max(processingEnd - start, ...entries.map((entry) => entry.duration));
    const busiest = entries.reduce((a, b) => (
      b.processingEnd - b.processingStart >= a.processingEnd - a.processingStart ? b : a
    ));
    const target = busiest.target ?? entries.find((entry) => entry.target)?.target;
    return {
      type: busiest.name,
      latency,
      inputDelay: processingStart - start,
      processing: processingEnd - processingStart,
      presentation: Math.max(0, start + latency - processingEnd),
      target: target?.isConnected ? dom.describe(target) : null,
    };
  });
}
