// What Lighthouse says about why the numbers are what they are: which element
// is the LCP and where its time went, which requests held the first render
// back, which elements shifted and what moved them. Explanations, not
// verdicts — nothing here touches a level.
//
// Lighthouse 13 computes them as insights from the page's trace. Their timings
// are observed on the unthrottled load, while the mobile and desktop metrics
// are simulated under throttling, so an LCP breakdown does not add up to the
// LCP in the table: it says where the time goes, in proportion. `observedMs`
// is carried alongside so nobody has to find that out the hard way.

// Runs in the audit worker, on one page load. Each part is null — or empty —
// when Lighthouse had nothing to say about it.
export function extractDiagnostics(lhr) {
  const audits = lhr?.audits ?? {};
  return {
    lcp: lcpBreakdown(audits['lcp-breakdown-insight']),
    renderBlocking: renderBlocking(audits['render-blocking-insight']),
    cls: layoutShifts(audits['cls-culprits-insight']),
  };
}

// The element that was the LCP, and the subparts its time splits into:
// timeToFirstByte, resourceLoadDelay, resourceLoadDuration, elementRenderDelay
// — the middle two only when the LCP is an image or another fetched resource.
function lcpBreakdown(audit) {
  const parts = audit?.details?.items ?? [];
  const table = parts.find((part) => part.type === 'table');
  if (!table) return null;

  return {
    element: element(parts.find((part) => part.type === 'node')),
    observedMs: Math.round(table.items.reduce((sum, item) => sum + item.duration, 0)),
    subparts: Object.fromEntries(table.items.map((item) => [item.subpart, Math.round(item.duration)])),
  };
}

// The stylesheets and scripts the first render waited for, longest first.
// `wastedMs` is Lighthouse's estimate of what each one cost the render.
function renderBlocking(audit) {
  return (audit?.details?.items ?? [])
    .map((item) => ({
      url: item.url,
      totalBytes: item.totalBytes ?? null,
      wastedMs: item.wastedMs == null ? null : Math.round(item.wastedMs),
    }))
    .sort((a, b) => (b.wastedMs ?? 0) - (a.wastedMs ?? 0));
}

// The layout shifts behind the CLS. Lighthouse groups shifts into clusters and
// the metric is the worst cluster's score, so only that cluster is kept: the
// shifts that make up the number in the table, biggest first, each with the
// element that moved most and the causes Lighthouse found — an unsized image,
// a web font, an injected iframe.
function layoutShifts(audit) {
  const clusters = (audit?.details?.items ?? []).filter((part) => part.type === 'table');
  const scored = clusters.map((cluster) => ({
    score: cluster.items.find((item) => item.node?.type === 'text')?.score ?? 0,
    shifts: cluster.items.filter((item) => item.node?.type !== 'text'),
  }));
  const worst = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
  if (!worst) return null;

  return {
    score: round3(worst.score),
    shifts: worst.shifts.map((shift) => ({
      element: element(shift.node),
      score: round3(shift.score ?? 0),
      causes: (shift.subItems?.items ?? []).map(({ cause, extra }) => ({
        cause,
        ...(extra?.type === 'node' ? { element: element(extra) } : {}),
        ...(extra?.type === 'url' ? { url: extra.value } : {}),
      })),
    })),
  };
}

// An element as the accessibility findings describe one: where it is, its
// opening tag, its text.
function element(node) {
  if (node?.type !== 'node') return null;
  return { selector: node.selector ?? '', snippet: node.snippet ?? '', label: node.nodeLabel ?? '' };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// Which load's diagnostics to report when the page was loaded several times.
// The metrics are medians, taken one metric at a time, so no single load is
// "the median run": the load whose LCP is the median need not be the one
// whose CLS is. Each diagnostic comes from the load that produced the number
// it explains — the LCP breakdown and the render-blocking requests from the
// median-LCP load, the layout shifts from the median-CLS load, the slowest
// interaction from the median-INP load. An even count
// has no middle load: its median sits halfway between two, and the first of
// them to have run is taken.
export function pickDiagnostics(samples, medians) {
  const lcpLoad = nearest(samples, 'lcp', medians.lcp);
  const clsLoad = nearest(samples, 'cls', medians.cls);
  // With no INP to be nearest to, what the first load says of why there is
  // none: nothing declared, or a state it could not reach.
  const inpLoad = nearest(samples, 'inp', medians.inp) ?? samples[0];
  return {
    lcp: lcpLoad?.diagnostics?.lcp ?? null,
    renderBlocking: lcpLoad?.diagnostics?.renderBlocking ?? [],
    cls: clsLoad?.diagnostics?.cls ?? null,
    inp: inpLoad?.diagnostics?.inp ?? null,
  };
}

function nearest(samples, key, median) {
  let best = null;
  for (const sample of samples) {
    if (typeof sample?.[key] !== 'number') continue;
    if (best == null || Math.abs(sample[key] - median) < Math.abs(best[key] - median)) best = sample;
  }
  return best;
}
