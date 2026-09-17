import { checkLabel, MODULES } from '../modules/index.js';

// GitHub shows a commit status description of at most 140 characters, so a page
// failing thirty axe rules has to say so in one line.
const MAX_DESCRIPTION = 140;

// Maps the audit's per-module results to a GitHub commit status payload, naming
// what fell over: `Failed on Performance: LCP, TBT · Accessibility: image-alt`.
// A warning never blocks a merge — only a failed check reports 'failure'.
export function commitStatusPayload(modules = {}) {
  const failed = checksAt(modules, 'fail');
  if (failed.length > 0) {
    return { state: 'failure', description: clip(`Failed on ${failed.join(' · ')}`) };
  }

  const warned = checksAt(modules, 'warn');
  if (warned.length > 0) {
    return { state: 'success', description: clip(`Warnings on ${warned.join(' · ')} — review before merging`) };
  }

  return { state: 'success', description: 'All checks within acceptable thresholds' };
}

// One entry per module with a check at that level, in registry order:
// 'Performance: LCP, TBT'.
function checksAt(modules, level) {
  const summaries = [];

  for (const mod of MODULES) {
    const levels = modules[mod.id]?.levels ?? {};
    const checks = Object.entries(levels)
      .filter(([, value]) => value === level)
      .map(([check]) => checkLabel(mod.id, check));
    if (checks.length > 0) summaries.push(`${mod.label}: ${checks.join(', ')}`);
  }

  return summaries;
}

function clip(text) {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}
