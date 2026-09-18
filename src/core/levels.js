// A verdict level is 'pass', 'warn' or 'fail'. Combining levels always keeps
// the worst: a failure on one form factor, or in one module, is not averaged
// away by passes elsewhere.
const SEVERITY = { pass: 0, warn: 1, fail: 2 };

export function worstLevel(levels) {
  let worst = 'pass';
  for (const level of levels) {
    if (SEVERITY[level] > SEVERITY[worst]) worst = level;
  }
  return worst;
}

// Worst-of merge of several { [check]: level } maps, check by check.
export function combineLevels(maps) {
  const combined = {};
  for (const levels of maps) {
    for (const [check, level] of Object.entries(levels)) {
      if (!combined[check] || SEVERITY[level] > SEVERITY[combined[check]]) {
        combined[check] = level;
      }
    }
  }
  return combined;
}
