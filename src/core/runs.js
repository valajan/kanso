// How many times a page is loaded before its measures are believed.
//
// A click timed once swings from one load to the next, enough on its own to
// fail a good change; several runs and their median is the remedy, and each
// one costs the states timed again. The ceiling is where that trade stops paying.
export const MAX_RUNS = 5;

// A run count is a whole number of loads between 1 and MAX_RUNS, whatever a
// config file or a command line asked for. The core clamps what it schedules,
// the runner clamps what it is handed, and a surface can call it to report the
// number of runs the audit will really do.
export function clampRuns(runs) {
  return Math.min(MAX_RUNS, Math.max(1, Math.trunc(runs ?? 1) || 1));
}
