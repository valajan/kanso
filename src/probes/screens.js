// The two screens Kanso audits on: a phone and a desktop, with the metrics
// and user agents Lighthouse emulates them with, so that a page is laid out
// as the tools a team already knows lay it out. A state is looked for on the
// screen it will be replayed on, since a phone's layout hides behind a drawer
// what a desktop shows.
//
// `cpuSlowdown` is how much slower than the machine at hand the device is
// taken to be — Lighthouse's multiplier, 4 for a phone, 1 for a desktop —
// applied by DevTools to the real CPU for a probe that times (INP), so that
// what it times is a phone's time and not the machine's running the audit.
export const SCREENS = {
  mobile: {
    width: 412,
    height: 823,
    deviceScaleFactor: 1.75,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
    cpuSlowdown: 4,
  },
  desktop: {
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    cpuSlowdown: 1,
  },
};

// A form factor's screen: its size, pixel density, and whether it is a
// phone's — laid out at its meta viewport, touched rather than clicked.
export function viewport(formFactor) {
  const { width, height, deviceScaleFactor, mobile } = SCREENS[formFactor];
  return { width, height, deviceScaleFactor, isMobile: mobile, hasTouch: mobile };
}
