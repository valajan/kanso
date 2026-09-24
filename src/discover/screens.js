import { screenEmulationMetrics, userAgents } from 'lighthouse/core/config/constants.js';

// The two screens Kanso audits on, as Lighthouse emulates them: a state is
// looked for on the screen it will be replayed on, since a phone's layout
// hides behind a drawer what a desktop shows.
export const SCREENS = {
  mobile: { ...screenEmulationMetrics.mobile, userAgent: userAgents.mobile },
  desktop: { ...screenEmulationMetrics.desktop, userAgent: userAgents.desktop },
};

export async function emulate(page, formFactor) {
  const { width, height, deviceScaleFactor, mobile, userAgent } = SCREENS[formFactor];
  const session = await page.createCDPSession();
  await session.send('Emulation.setScrollbarsHidden', { hidden: true });
  await page.setViewport({ width, height, deviceScaleFactor, isMobile: mobile, hasTouch: mobile });
  await page.setUserAgent(userAgent);
}
