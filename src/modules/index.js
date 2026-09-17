import performance from './performance/index.js';

// Audit modules: one per concern Kanso checks on a page. Adding one = a folder
// under modules/ + one line in MODULES.
//
// A module is a plain object:
//
//   id          names the module in results and configuration
//   label       display name
//   categories  the Lighthouse categories it reads
//
//   extract(lhr) → sample
//     Runs inside the audit worker, once per page load. The sample crosses a
//     thread boundary, so keep only what the module needs.
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
//     conclusion is the worst of them. Anything else returned is the module's
//     own detail, passed through to whoever reports it.
export const MODULES = [performance];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

export function getModule(id) {
  const mod = BY_ID.get(id);
  if (!mod) throw new Error(`Unknown audit module: ${id}`);
  return mod;
}
