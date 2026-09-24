import { moduleConfig } from '../config/module-config.js';
import { parseIgnore } from '../modules/findings.js';
import { MODULES } from '../modules/index.js';
import { skippedProbes } from '../probes/index.js';
import { worstLevel } from './levels.js';
import { clampRuns } from './runs.js';

export const FORM_FACTORS = ['mobile', 'desktop'];

// Where a runner puts the page's screenshot, beside what the modules made of
// the load, when it was asked for one. A symbol, so that no module id can ever
// be mistaken for it, and every runner that knows nothing of screenshots goes
// on working.
export const SCREENSHOT = Symbol('screenshot');

// Audits one page with every module, optionally against a baseline page, and
// returns the verdict. Nothing here knows about pull requests, forges or
// servers: the PR report is one caller among others.
//
// - url:           the page under audit
// - baseline:      the page to compare against, or null
// - config:        the resolved .kanso.yml
// - runLighthouse: (url, { formFactor, runs, modules, config, screenshot }) →
//                  { [moduleId]: data }, plus, under SCREENSHOT, the page as
//                  its load ended — a JPEG data URI — when `screenshot` asked
//                  for it. `config` is the same resolved file: the probes read
//                  their own section of it, inside the worker
// - modules:       defaults to every registered module
// - alwaysCompare: load the baseline even for modules that could judge without
//                  it. A baseline named in the configuration is a hint, and
//                  skipping it saves half the audit; a baseline the caller
//                  asked for by hand is an instruction, and the comparison is
//                  what they came for, verdict or no verdict.
// - screenshots:   also return what the page under audit looked like at the
//                  end of its load, on each form factor — never the
//                  baseline's. For a surface that can show an image.
// - record:        a directory where each load keeps a journal of what its
//                  probes did (src/probes/journal.js). Handed to the runner
//                  as { dir, side }; the verdict does not depend on it.
//
// All loads start together; the runner caps how many Chrome instances run at
// once. A failed load only costs its own column: the audit is an error when
// the page under audit failed on every form factor.
//
// Each module's result also says, as `skipped`, which of its probes did not
// run because the project declares no state — { probe, rules, reason } — the
// rules it would have checked less the ones `ignore:` leaves out. A rule
// nobody checked is not a rule that passed, and a surface says so.
//
// Resolves to { ok: true, conclusion, modules: { [id]: { conclusion, levels, skipped, ... } }, failures }
// or { ok: false, conclusion: 'error', error, failures }, where each failure is
// { side: 'current' | 'baseline', formFactor, url, error } — plus, when asked
// for and the audit ran, `screenshots: { [formFactor]: dataUri | null }`.
export async function audit({ url, baseline = null, config = {}, runLighthouse, modules = MODULES, alwaysCompare = false, screenshots = false, record = null }) {
  const runs = clampRuns(config.runs);
  // Each module is judged by its own section of the config and never sees the
  // rest of the file — see src/config/module-config.js.
  const configs = new Map(modules.map((m) => [m.id, moduleConfig(config, m.id)]));
  const baselineModules = baseline
    ? modules.filter((m) => alwaysCompare || (m.needsBaseline?.(configs.get(m.id)) ?? true))
    : [];

  const loads = [
    ...FORM_FACTORS.map((formFactor) => ({ side: 'current', formFactor, url, modules })),
    ...(baselineModules.length > 0
      ? FORM_FACTORS.map((formFactor) => ({ side: 'baseline', formFactor, url: baseline, modules: baselineModules }))
      : []),
  ];
  const settled = await Promise.allSettled(loads.map((load) => runLighthouse(load.url, {
    formFactor: load.formFactor,
    runs,
    modules: load.modules,
    config,
    ...(screenshots && load.side === 'current' ? { screenshot: true } : {}),
    ...(record ? { record: { dir: record, side: load.side } } : {}),
  })));

  const loaded = Object.fromEntries(FORM_FACTORS.map((ff) => [ff, { current: null, baseline: null }]));
  const failures = [];
  settled.forEach((result, i) => {
    const { side, formFactor, url: target } = loads[i];
    if (result.status === 'fulfilled') {
      loaded[formFactor][side] = result.value;
    } else {
      failures.push({ side, formFactor, url: target, error: result.reason?.message ?? String(result.reason) });
    }
  });

  if (FORM_FACTORS.every((ff) => loaded[ff].current == null)) {
    return { ok: false, conclusion: 'error', error: failures[0]?.error ?? 'unknown error', failures };
  }

  const results = {};
  for (const mod of modules) {
    const formFactors = Object.fromEntries(FORM_FACTORS.map((ff) => [ff, {
      current: loaded[ff].current?.[mod.id] ?? null,
      baseline: loaded[ff].baseline?.[mod.id] ?? null,
    }]));
    const evaluation = mod.evaluate({ formFactors, baselineAudited: baselineModules.includes(mod) }, configs.get(mod.id));
    results[mod.id] = { ...evaluation, conclusion: worstLevel(Object.values(evaluation.levels)), skipped: skipped(mod, config) };
  }

  return {
    ok: true,
    conclusion: worstLevel(Object.values(results).map((r) => r.conclusion)),
    modules: results,
    failures,
    ...(screenshots
      ? { screenshots: Object.fromEntries(FORM_FACTORS.map((ff) => [ff, loaded[ff].current?.[SCREENSHOT] ?? null])) }
      : {}),
  };
}

// The probes of a module left out for want of a state, and the rules each
// would have checked — none that the module's `ignore:` names, which nobody
// asked to be checked.
function skipped(mod, config) {
  const ignore = parseIgnore(moduleConfig(config, mod.id).ignore);
  return skippedProbes(mod, config)
    .map((skip) => ({ ...skip, rules: skip.rules.filter((rule) => !ignore.includes(rule)) }))
    .filter((skip) => skip.rules.length > 0);
}
