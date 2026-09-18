import puppeteer from 'puppeteer-core';

// Probes: what Kanso checks on a page itself, for what Lighthouse does not look
// at — how the page reflows at 320 CSS pixels, what a keyboard can reach. A
// module declares them (src/modules/index.js); this runs them, inside the audit
// worker, on the Chrome Lighthouse has just finished with.
//
// Each probe gets a page of its own, in a browser context of its own: a first
// visit, as Lighthouse's is, with nothing another probe clicked, scrolled or
// dismissed. Lighthouse's own tab is closed by then, and its throttling with
// it; a probe measures no time, and a slowed CPU would only make it slower.
// It sees the page as Lighthouse loaded it — same screen, same user agent —
// unless it asks for another screen.
//
// A probe that throws or runs out of time costs its own rules, not the load:
// what Lighthouse found stands, and the failure is reported, never read as
// "nothing found".

// How long one probe may take, page load included.
export const PROBE_TIMEOUT_MS = 30_000;

// How long a loaded page is given to go quiet on the network — the requests a
// client-rendered page makes after `load` to draw itself — before a probe reads
// it anyway. Best effort: a page that polls never goes quiet.
const SETTLE_MS = 5_000;

// Runs every probe the modules declare for this form factor, one after the
// other, and resolves to { [moduleId]: { findings, failures } } — only for the
// modules that have probes to run. Each failure is { probe, rules, error }:
// `rules` are what the probe would have checked, and so what nobody did.
//
// - port:       the debugging port of the Chrome to use
// - settings:   the report's configSettings — how Lighthouse emulated the page
export async function runProbes({ port, url, formFactor, settings, modules, timeoutMs = PROBE_TIMEOUT_MS }) {
  const wanted = modules.flatMap((mod) => (mod.probes ?? [])
    .filter((probe) => probe.formFactors?.includes(formFactor) ?? true)
    .map((probe) => ({ mod, probe })));
  if (wanted.length === 0) return {};

  const results = {};
  for (const { mod } of wanted) results[mod.id] ??= { findings: [], failures: [] };
  const fail = (mod, probe, err) => results[mod.id].failures.push({ probe: probe.id, rules: probe.rules, error: message(err) });

  let browser;
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch (err) {
    for (const { mod, probe } of wanted) fail(mod, probe, err);
    return results;
  }

  try {
    // One at a time: a probe presses keys and reads focus, which only the page
    // in front has.
    for (const { mod, probe } of wanted) {
      try {
        results[mod.id].findings.push(...await runProbe(browser, probe, { url, formFactor, settings, timeoutMs }));
      } catch (err) {
        fail(mod, probe, err);
      }
    }
  } finally {
    await browser.disconnect().catch(() => {});
  }
  return results;
}

async function runProbe(browser, probe, { url, formFactor, settings, timeoutMs }) {
  const context = await browser.createBrowserContext();
  let timer;
  try {
    const run = async () => {
      const page = await context.newPage();
      // Scrollbars laid over the page, as on a phone or a Mac: a classic one
      // would take 15 px off the width a probe asked for.
      const session = await page.createCDPSession();
      await session.send('Emulation.setScrollbarsHidden', { hidden: true });
      await page.setViewport({ ...screen(settings), ...probe.viewport });
      if (typeof settings?.emulatedUserAgent === 'string') await page.setUserAgent(settings.emulatedUserAgent);
      if (probe.media) await page.emulateMediaFeatures(probe.media);
      await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
      await page.bringToFront();
      return probe.run(page, { url, formFactor });
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    // A probe that lost the race still settles later, when its context is
    // closed under it: that rejection is expected, and nobody's to handle.
    const running = run();
    running.catch(() => {});
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
    // Closing the context closes its page, and whatever the probe left
    // pending in it.
    await context.close().catch(() => {});
  }
}

// Lighthouse's screen emulation, as puppeteer takes a viewport.
function screen(settings) {
  const emulation = settings?.screenEmulation ?? {};
  const mobile = emulation.mobile ?? settings?.formFactor !== 'desktop';
  return {
    width: emulation.width ?? (mobile ? 412 : 1350),
    height: emulation.height ?? (mobile ? 823 : 940),
    deviceScaleFactor: emulation.deviceScaleFactor ?? 1,
    isMobile: mobile,
    hasTouch: mobile,
  };
}

function message(err) {
  return (err?.message ?? String(err)).split('\n')[0];
}
