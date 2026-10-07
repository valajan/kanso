// A record read finding by finding — `findings.json`, beside the journals in
// the directory a record is kept in (src/core/record.js). The journals say
// what each probe did, in order, load by load, and the result what the audit
// concluded; neither answers at once what whoever fixes the page asks: what
// failed, where, why, and what it looks like. This does — for an agent, which
// reads one file and opens the pictures it names, and for the page a person
// opens (src/core/viewer.js), which draws the same list.
//
//   { schema, about, url, baseline, conclusion, counts: { fail, warn, pass },
//     findings: [{
//       id, module, rule, title, standard, level, impact, needsReview,
//       inState, reach, comparedToBaseline, count, screens, foundBy,
//       elements: [{ selector, snippet, label, explanation, url }],
//       pictures: [{ image, screen, width, height, scale,
//                    boxes: [{ n, selector, label, explanation, coveredBy, x, y, width, height }] }] }],
//     notChecked: [{ module, probe, rules, inState, screen, page, reason }],
//     measures: { [module]: { levels, budgets, scores, diagnostics } },
//     files: { result, page, journals } }
//
// The names are this file's own, chosen to be read cold: the result's `at` is
// `inState` here, and its `state` — what the baseline makes of a finding —
// `comparedToBaseline`.
//
// A picture is the evidence a probe took of a finding (src/probes/evidence.js):
// part of the page, the failing elements boxed in red in the image itself and
// numbered when there are several; `boxes` says which number is which element,
// and where it is in the picture, in CSS pixels — with `coveredBy`, and a
// dashed box, for an element behind something else, which is what the picture
// shows at that place. A finding is joined to its
// pictures by its rule and its state, on the page under audit, screen by
// screen — the same key the audit folds it by.
import { explanationLine } from '../modules/findings.js';

export const DIGEST_SCHEMA = 1;

const ABOUT = [
  'What a Kanso audit found, one entry per finding, worst first.',
  'level is the verdict on it: fail, warn, or pass (already in the baseline). inState is the declared state of the page it was found in — null for the page as it loads — and reach the click that opens that state.',
  'elements lists every failing element, each with what is wrong with it. pictures are screenshots of part of the page, paths relative to this file, with the failing elements outlined in red in the image; when a picture shows several they are numbered, and boxes says which number is which element. A dashed outline is an element behind something else, which coveredBy names: the picture shows what is over it, not the element. An element with no box took no room on the page when the picture was taken, or is behind the same thing as one that has a box.',
  'notChecked lists what no probe could check: never read it as clean. measures holds what was timed rather than checked. files names the full result (the JSON of `kanso audit --json`), the page a person opens, and the journals: one JSON Lines file per page load, every step of every probe, to filter by rule, probe or at.',
].join(' ');

const LEVELS = { fail: 0, warn: 1, pass: 2 };

// - result: the audit's result, as `kanso audit --json` prints it
// - loads:  the journals of the record — [{ name, side, formFactor, events }]
export function digest({ result, loads = [] }) {
  const current = loads.filter((load) => load.side === 'current');
  const modules = Object.entries(result?.modules ?? {});

  const findings = modules
    .flatMap(([module, { findings }]) => (findings ?? []).map((finding) => ({ module, ...finding })))
    .sort((a, b) => (LEVELS[a.level] ?? 3) - (LEVELS[b.level] ?? 3))
    .map(({ module, rule, at, title, detail, level, impact, needsReview, state, count, formFactors = [], nodes = [] }) => {
      const ours = (event) => event.rule === rule && (event.at ?? null) === (at ?? null);
      const on = current.filter((load) => formFactors.includes(load.formFactor));
      return {
        id: at ? `${rule}@${at}` : rule,
        module,
        rule,
        title: title ?? null,
        standard: detail ?? null,
        level: level ?? null,
        impact: impact ?? null,
        needsReview: needsReview === true,
        inState: at ?? null,
        reach: at ? reachOf(at, current) : null,
        comparedToBaseline: state ?? null,
        count,
        screens: formFactors,
        foundBy: [...new Set(on.flatMap((load) => load.events.filter((event) => event.kind === 'finding' && ours(event)).map((event) => event.probe)))],
        elements: nodes.map(({ selector, snippet, label, explanation, url }) => clean({ selector, snippet, label, explanation: explanationLine(explanation), url })),
        pictures: on.flatMap((load) => load.events
          .filter((event) => event.kind === 'evidence' && event.frame && ours(event))
          .map((event) => ({
            image: event.frame.file,
            screen: load.formFactor,
            width: event.frame.width,
            height: event.frame.height,
            scale: event.frame.scale,
            boxes: (event.boxes ?? []).map(({ n, selector, label, explanation, coveredBy, rect }) => clean({ n, selector, label, explanation: explanationLine(explanation), coveredBy, ...rect })),
          }))),
      };
    });

  const notChecked = modules.flatMap(([module, { probeFailures, skipped }]) => [
    ...(probeFailures ?? []).map(({ probe, rules, at, formFactor, side, error }) => ({
      module, probe, rules, inState: at ?? null, screen: formFactor ?? null, page: side ?? 'current', reason: error,
    })),
    ...(skipped ?? []).map(({ probe, rules }) => ({
      module, probe, rules, inState: null, screen: null, page: 'current', reason: 'no state is declared, and this probe checks nothing without one',
    })),
  ]);

  const measures = Object.fromEntries(modules
    .filter(([, mod]) => mod.scores)
    .map(([module, { levels, budgets, scores, diagnostics }]) => [module, clean({ levels, budgets, scores, diagnostics })]));

  const count = (level) => findings.filter((finding) => finding.level === level).length;
  return {
    schema: DIGEST_SCHEMA,
    about: ABOUT,
    url: result?.url ?? null,
    baseline: result?.baseline ?? null,
    conclusion: result?.conclusion ?? null,
    counts: { fail: count('fail'), warn: count('warn'), pass: count('pass') },
    findings,
    notChecked,
    measures,
    files: { result: 'audit.json', page: 'index.html', journals: loads.map((load) => load.name) },
  };
}

// The click that opened `state`, as the first probe to reach it made it.
function reachOf(state, loads) {
  for (const load of loads) {
    const reached = load.events.find((event) => event.kind === 'state-reached' && event.at === state);
    if (reached) return clean({ click: reached.click, waitFor: reached.waitFor });
  }
  return null;
}

// Without what is not there: an element with no label says nothing of it.
function clean(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null && value !== ''));
}
