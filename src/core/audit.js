import { MODULES } from '../modules/index.js';
import { worstLevel } from './levels.js';
import { clampRuns } from './runs.js';

export const FORM_FACTORS = ['mobile', 'desktop'];

// Audits one page with every module, optionally against a baseline page, and
// returns the verdict. Nothing here knows about pull requests, forges or
// servers: the PR report is one caller among others.
//
// - url:           the page under audit
// - baseline:      the page to compare against, or null
// - config:        the resolved .kanso.yml
// - runLighthouse: (url, { formFactor, runs, modules }) → { [moduleId]: data }
// - modules:       defaults to every registered module
// - alwaysCompare: load the baseline even for modules that could judge without
//                  it. A baseline named in the configuration is a hint, and
//                  skipping it saves half the audit; a baseline the caller
//                  asked for by hand is an instruction, and the comparison is
//                  what they came for, verdict or no verdict.
//
// All loads start together; the runner caps how many Chrome instances run at
// once. A failed load only costs its own column: the audit is an error when
// the page under audit failed on every form factor.
//
// Resolves to { ok: true, conclusion, modules: { [id]: { conclusion, levels, ... } }, failures }
// or { ok: false, conclusion: 'error', error, failures }, where each failure is
// { side: 'current' | 'baseline', formFactor, url, error }.
export async function audit({ url, baseline = null, config = {}, runLighthouse, modules = MODULES, alwaysCompare = false }) {
  const runs = clampRuns(config.runs);
  const baselineModules = baseline
    ? modules.filter((m) => alwaysCompare || (m.needsBaseline?.(config) ?? true))
    : [];

  const loads = [
    ...FORM_FACTORS.map((formFactor) => ({ side: 'current', formFactor, url, modules })),
    ...(baselineModules.length > 0
      ? FORM_FACTORS.map((formFactor) => ({ side: 'baseline', formFactor, url: baseline, modules: baselineModules }))
      : []),
  ];
  const settled = await Promise.allSettled(
    loads.map((load) => runLighthouse(load.url, { formFactor: load.formFactor, runs, modules: load.modules }))
  );

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
    const evaluation = mod.evaluate({ formFactors, baselineAudited: baselineModules.includes(mod) }, config);
    results[mod.id] = { ...evaluation, conclusion: worstLevel(Object.values(evaluation.levels)) };
  }

  return {
    ok: true,
    conclusion: worstLevel(Object.values(results).map((r) => r.conclusion)),
    modules: results,
    failures,
  };
}
