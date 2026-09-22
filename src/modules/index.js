import accessibility from './accessibility/index.js';
import bestPractices from './best-practices/index.js';
import performance from './performance/index.js';
import seo from './seo/index.js';

// Audit modules: one per concern Kanso checks on a page. Adding one = a folder
// under modules/ + one line in MODULES.
//
// A module is a plain object:
//
//   id          names the module in results and in its .kanso.yml section
//   label       display name
//   categories  the Lighthouse categories it reads
//   checkLabels optional { [check]: label } for the names `levels` uses, when
//               the check's own name does not read well in a report
//
//   probes      optional [{ id, rules, formFactors?, viewport?, media?, beforeLoad?, states?, run(page, context) }]
//               What the module checks on the page itself, for what Lighthouse
//               does not look at: how it reflows at 320 CSS pixels, what a
//               keyboard can reach. Each runs in the audit worker after
//               Lighthouse, on the same Chrome, in a fresh page of its own —
//               laid out as Lighthouse laid it out, unless it asks for another
//               `viewport` or emulated `media` features, with `beforeLoad` run
//               in the page before any of its scripts — and resolves to
//               findings. `rules` are the ones it can report: when it fails,
//               they are what nobody checked — a list, or a function of the
//               module's own section of the configuration, which a probe is
//               also handed as `config` when it runs. `formFactors` restricts
//               it to some loads. Probes run on the first load of a page that
//               succeeds, not on every repeated run: what they check does not
//               vary from one load to the next. `states: true` has it read the
//               page again in each state the project declares — a menu
//               opened, a dialog shown (src/config/states.js) — in the page it
//               loaded, and each finding made there says which, as `at`. See
//               src/probes/index.js.
//
//   extract(lhr, { artifacts, probed }) → sample
//     Runs inside the audit worker, once per page load. `lhr` is the Lighthouse
//     report; `artifacts` is what Lighthouse gathered from the page to run its
//     audits, for the facts it holds and does not report — the page's meta
//     tags, say. `probed` is what the module's probes made of the page,
//     { findings, failures }, or null when none ran on this load. The sample
//     crosses a thread boundary, so keep only what the module needs.
//
//   combine(samples) → data
//     Folds the samples of repeated loads into one result: a noisy measure
//     takes the median, a deterministic check can keep the first.
//
//   needsBaseline(config) → boolean                      (optional, default true)
//     False when the configuration alone is enough to judge, so the baseline
//     page is not loaded for this module.
//
//   evaluate({ formFactors, baselineAudited }, config) → { levels, ... }
//     Judges the combined data. `formFactors` maps each form factor to
//     { current, baseline }, either side null when its load failed.
//     `levels` maps each check to 'pass' | 'warn' | 'fail', and the module's
//     conclusion is the worst of them. `config` is the module's own section of
//     the resolved .kanso.yml (src/config/module-config.js).
//
// Whatever else `evaluate` returns is the module's own detail, passed through
// to whoever reports it. Two shapes of detail are understood by every surface —
// a module returns either, both or neither:
//
//   scores    { [formFactor]: { current, reference } }
//             Measures: a number per check, read against a reference. They are
//             noisy, they need several runs and a median, and they are rendered
//             as a table with a delta column.
//
//   findings  [{ rule, title, impact, count, nodes, detail?, needsReview?, at?, state, level, formFactors }]
//             Findings: a rule broken on a set of elements. They are
//             deterministic, one load settles them, and they are rendered as a
//             list, worst first. `impact` is on one scale for every module
//             (impact.js), `nodes` are the elements it failed on (findings.js
//             says what one carries), `detail` what Lighthouse says of the
//             failure as a whole when it says more than the title.
//             `needsReview` is a rule that was raised rather than decided —
//             axe saying it cannot tell — whose impact is capped so that a
//             doubt fails no audit on its own. `at` is the declared state of
//             the page it was found in — absent for the page as it loads —
//             and a rule broken in two states is two findings. `state` is
//             'new' | 'worse' | 'inherited' when a baseline was compared, and
//             null when there was none. null — rather than [] — means no load
//             produced a result. A module reporting findings shares everything
//             but its category and its impacts: see findings.js.
//
// Performance produces the first; accessibility, SEO and best practices the
// second. A module that produces neither still reports through `levels`, which
// is the only part of the contract the core itself relies on.
export const MODULES = [performance, accessibility, seo, bestPractices];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export function getModule(id) {
  const mod = BY_ID.get(id);
  if (!mod) throw new Error(`Unknown audit module: ${id}`);
  return mod;
}

// How a check is named in a report. A module's checks are its own vocabulary:
// performance's are metric keys, and reading "LCP" beats reading "lcp"; the
// others' are Lighthouse audit ids, which are already the name to read.
export function checkLabel(moduleId, check) {
  return BY_ID.get(moduleId)?.checkLabels?.[check] ?? check;
}
