import { impactOf } from './rules.js';

// What opening and closing a state again and again leaves in memory. A
// transition probe (src/probes/transition.js): the state is opened with a
// click and closed however it closes, CYCLES times, and after each cycle the
// garbage is collected and the page's counters read — the DOM nodes it holds,
// attached or not, the documents, the event listeners. A menu that builds its
// items on each opening and never lets go of the last ones, a dialog that adds
// a listener to the window each time it shows: what one cycle hides, ten show.
//
//   dom-leak       the nodes, or the documents, grow with every cycle
//   listener-leak  the event listeners grow with every cycle
//
// The first cycles are left out: a state often builds what it shows the first
// time only, and keeps it — that is a cache, not a leak. What is judged is
// growth that goes on: a count higher at the end than after the warm-up by
// more than the line below per cycle, and that fell back at no cycle between.
const CYCLES = 8;
const WARM_UP = 2;

// Growth per cycle from which a count leaks.
const LINES = {
  nodes: 20,
  documents: 0.5,
  jsEventListeners: 1,
};

const TEXT = {
  'dom-leak': ['Opening and closing a state keeps adding to the page', 'DOM nodes kept after each cycle are never let go'],
  'listener-leak': ['Opening and closing a state keeps adding event listeners', 'Listeners added on each cycle are never removed'],
};

export const leaks = {
  id: 'leaks',
  rules: Object.keys(TEXT),
  transitions: true,
  // Sixteen openings and closings a state, the same picture each time: they
  // would spend a load's frames on nothing the journal needs to show.
  frames: false,

  async transition(page, state, tools) {
    const trigger = await tools.trigger();
    const session = await page.createCDPSession();
    const counters = async () => {
      await session.send('HeapProfiler.collectGarbage');
      return session.send('Memory.getDOMCounters');
    };

    const readings = [];
    for (let i = 0; i < CYCLES; i++) {
      await tools.open();
      const { closed } = await tools.closeAnyway();
      // A state that does not close cannot be opened again from where it
      // was: nothing to measure.
      if (closed !== true) return [];
      readings.push(await counters());
    }
    tools.log.log('counters', { readings });
    await session.detach().catch(() => {});

    const found = [];
    const measured = readings.slice(WARM_UP - 1);
    const cycles = measured.length - 1;
    const grows = (key) => {
      const values = measured.map((reading) => reading[key]);
      const perCycle = (values.at(-1) - values[0]) / cycles;
      const steady = values.every((value, i) => i === 0 || value >= values[i - 1]);
      return steady && perCycle >= LINES[key] ? { from: values[0], to: values.at(-1), perCycle } : null;
    };
    const nodes = grows('nodes') ?? grows('documents');
    if (nodes) {
      const what = grows('nodes') ? 'DOM nodes' : 'documents';
      found.push(finding('dom-leak', trigger, `${what} went from ${nodes.from} to ${nodes.to} over ${cycles} more cycles — ${round(nodes.perCycle)} kept per opening`));
    }
    const listeners = grows('jsEventListeners');
    if (listeners) {
      found.push(finding('listener-leak', trigger, `event listeners went from ${listeners.from} to ${listeners.to} over ${cycles} more cycles — ${round(listeners.perCycle)} added per opening`));
    }
    return found;
  },
};

function finding(rule, node, explanation) {
  const [title, detail] = TEXT[rule];
  return { rule, title, impact: impactOf(rule), count: 1, nodes: [{ ...node, explanation }], detail };
}

function round(n) {
  return Math.round(n * 10) / 10;
}
