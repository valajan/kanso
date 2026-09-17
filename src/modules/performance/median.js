// Per-metric median of several score objects.
//
// A single Lighthouse run is noisy — TBT in particular swings 20-30% between
// identical runs on shared CPU — which is enough to trip a 10% regression
// threshold on its own and spend an LLM call analysing nothing. Taking the
// median of an odd number of runs is the standard remedy (it is what Lighthouse
// CI does by default); the median is used rather than the mean so one outlier
// run cannot drag the result.
export function medianScores(scores) {
  const usable = scores.filter((s) => s != null);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const out = {};
  for (const key of Object.keys(usable[0])) {
    const values = usable.map((s) => s[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (values.length === 0) continue;
    const mid = Math.floor(values.length / 2);
    out[key] = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }
  return out;
}
