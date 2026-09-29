import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseStates } from '../../src/config/states.js';
import { checkStates } from '../../src/discover/check.js';
import { serveDirectory } from '../../src/serve/static.js';

// The states someone else proposes, replayed against a real Chrome on pages
// whose answers are known. check.html has a control for each question a
// proposed state can ask — a menu with a submenu, a selector matching two
// buttons, a click that does nothing, one dialog two buttons open, a close
// that closes and one that does not, a write, a route change, a drawer a
// phone alone has; stopped.html a beacon that never stops, beside a panel and
// a payment.
//
// What is tested is what Kanso says of each state, not what an agent should
// make of it.
//
//   npm run test:check      (needs Chrome, ~1 min)

let site;

before(async () => {
  site = await serveDirectory(fileURLToPath(new URL('./pages', import.meta.url)));
});

after(async () => {
  await site?.close();
});

const urlOf = (page) => new URL(page, site.url).href;

const PROPOSED = parseStates([
  { name: 'menu', click: 'header button.burger', wait_for: '#menu.open', states: [{ name: 'products', click: '#products' }] },
  { name: 'late', click: '#menu-button', wait_for: '#never', states: [{ name: 'under-late', click: '#products' }] },
  { name: 'missing', click: '#missing' },
  { name: 'twins', click: '.twin', wait_for: '#twin-panel p' },
  { name: 'nothing', click: '#nothing' },
  { name: 'signin', click: '#signin', close: '#auth-close', states: [{ name: 'signin-x', click: '#auth-close' }] },
  { name: 'account', click: '#account' },
  { name: 'filters', click: '#filters', close: '#filters-done' },
  { name: 'save', click: '#save' },
  { name: 'route', click: '#route' },
  { name: 'drawer', form_factor: 'mobile', click: '#drawer-button' },
]);

// One check of check.html on both screens, which every test below reads.
let checked;
const heard = [];
function result() {
  checked ??= checkStates(urlOf('check.html'), PROPOSED, { onProgress: (event) => heard.push(event) });
  return checked;
}
const stateOn = async (formFactor, name) => (await result()).screens[formFactor].states.find((s) => s.name === name);

describe('checking proposed states', { concurrency: 4 }, () => {
  test('a state is reached down its path, and says what it brought and what can be clicked in it', async () => {
    const menu = await stateOn('mobile', 'menu');
    assert.equal(menu.reached, true);
    assert.equal(menu.changed, true);
    assert.ok(menu.appeared.includes('button|Products|expanded=false'), menu.appeared.join(', '));
    assert.ok(menu.appeared.includes('button|Menu|expanded=true'));
    assert.ok(menu.newText.includes('About us'));
    assert.deepEqual(menu.revealed, [
      { role: 'link', name: 'About us', selector: 'a[href="#about"]' },
      { role: 'button', name: 'Products', selector: '#products' },
    ]);
    assert.equal(menu.revealedMore, 0);
    assert.deepEqual(menu.waitFor, { selector: '#menu.open', matchesBefore: 0, matches: 1 });

    const products = await stateOn('mobile', 'products');
    assert.deepEqual({ from: products.from, path: products.path, reached: products.reached }, { from: 'menu', path: ['menu'], reached: true });
    // Two links alike, offered once, saying how many there are.
    assert.deepEqual(products.revealed, [{ role: 'link', name: 'Anvils', selector: 'a[href="#anvils"]', alike: 2 }]);
  });

  test('the element clicked is named, with the steadiest selector that finds it alone', async () => {
    const menu = await stateOn('mobile', 'menu');
    assert.deepEqual(menu.click, {
      selector: 'header button.burger', matches: 1, visible: 1, firstVisible: true,
      role: 'button', name: 'Menu', steadiest: { kind: 'id', selector: '#menu-button' },
    });
  });

  test('a selector matching two elements is said to, and the first is the one clicked', async () => {
    const twins = await stateOn('desktop', 'twins');
    assert.equal(twins.reached, true);
    assert.equal(twins.click.matches, 2);
    assert.equal(twins.click.name, 'See the offer');
    assert.deepEqual(twins.click.steadiest, { kind: 'id', selector: '#twin-a' });
    // What it waits for was in the page before the click, hidden: a wait
    // for nothing.
    assert.equal(twins.waitFor.matchesBefore, 1);
  });

  test('a click that changes nothing is reached, and flagged as changing nothing', async () => {
    const nothing = await stateOn('mobile', 'nothing');
    assert.equal(nothing.reached, true);
    assert.equal(nothing.changed, false);
    assert.equal(nothing.duplicates, null);
    assert.deepEqual([nothing.appeared, nothing.disappeared, nothing.newText], [[], [], []]);
  });

  test('two buttons that open one dialog are two states, the second a duplicate of the first', async () => {
    for (const formFactor of ['mobile', 'desktop']) {
      const [signin, account] = [await stateOn(formFactor, 'signin'), await stateOn(formFactor, 'account')];
      assert.equal(signin.duplicates, null);
      assert.equal(account.duplicates, 'signin', formFactor);
      assert.ok(signin.appeared.includes('dialog|Sign in'));
      assert.deepEqual(signin.revealed, [{ role: 'button', name: 'Close', selector: '#auth-close' }]);
    }
  });

  test('a state whose click closes the one it starts from is said to, and is no duplicate', async () => {
    for (const formFactor of ['mobile', 'desktop']) {
      const x = await stateOn(formFactor, 'signin-x');
      assert.equal(x.reached, true);
      assert.equal(x.closesParent, 'signin', formFactor);
      assert.equal(x.duplicates, null);
    }
    assert.equal((await stateOn('mobile', 'menu')).closesParent, undefined);
  });

  test('a close that brings the page back closes; one that leaves the state open does not', async () => {
    assert.deepEqual((await stateOn('mobile', 'signin')).close, { selector: '#auth-close', matches: 1, closed: true });
    const filters = await stateOn('mobile', 'filters');
    assert.equal(filters.reached, true);
    assert.equal(filters.close.closed, false);
    assert.match(filters.close.reason, /not back/);
  });

  test('a state is not reached when its wait never ends, its click finds nothing, the guards stop it or it changes route — and neither is what is under it', async () => {
    const pick = ({ reached, step, through, stopped }) => ({ reached, step, ...(through ? { through } : {}), ...(stopped ? { stopped } : {}) });
    const states = Object.fromEntries((await result()).screens.mobile.states.map((s) => [s.name, s]));
    assert.deepEqual(pick(states.late), { reached: false, step: 'wait_for' });
    assert.match(states.late.reason, /#never never appeared/);
    assert.deepEqual(pick(states['under-late']), { reached: false, step: 'path', through: 'late' });
    assert.equal(states['under-late'].click, undefined, 'not tried');
    assert.deepEqual(pick(states.missing), { reached: false, step: 'click' });
    assert.equal(states.missing.click.matches, 0);
    assert.deepEqual(pick(states.save), { reached: false, step: 'guards', stopped: ['POST /api/save'] });
    assert.deepEqual(pick(states.route), { reached: false, step: 'left' });
  });

  test('a state kept to one screen is checked on that screen alone', async () => {
    const { screens } = await result();
    assert.equal((await stateOn('mobile', 'drawer')).reached, true);
    assert.equal(screens.desktop.states.some((s) => s.name === 'drawer'), false);
  });

  test('the page is stable, the summary counts it all, and progress was heard for every state on every screen', async () => {
    const { screens, summary } = await result();
    assert.equal(screens.mobile.stable, true);
    assert.deepEqual(screens.mobile.drift, { appeared: [], disappeared: [] });
    // 14 states on a phone, 13 on a desktop; on each, five not reached (late
    // and what is under it, missing, save, route), one unchanged, one
    // duplicate, one closing its parent, one close that does not close, one
    // selector matching two.
    assert.deepEqual(summary, {
      checked: 27, reached: 17, unreached: 10, unchanged: 2, duplicates: 2, closesParent: 2, closeBroken: 2, ambiguous: 2, waitsForNothing: 2, ok: false,
    });
    assert.equal(heard.length, 27);
    assert.deepEqual(heard.filter((e) => e.formFactor === 'mobile').map((e) => e.done), Array.from({ length: 14 }, (_, i) => i + 1));
  });

  test('a click that finds nothing shown says what its selector matched: hidden on this screen, or hidden before one shown', async () => {
    const { screens } = await checkStates(urlOf('check.html'), parseStates([
      { name: 'drawer-everywhere', click: '#drawer-button' },
      { name: 'offer', click: '[data-offer]' },
    ]), { formFactors: ['desktop'] });
    const [drawer, offer] = screens.desktop.states;
    assert.deepEqual([drawer.reached, drawer.step], [false, 'click']);
    assert.match(drawer.reason, /matches an element, hidden on this screen — form_factor:/);
    assert.deepEqual([offer.reached, offer.step, offer.click.matches, offer.click.firstVisible], [false, 'click', 2, false]);
    assert.deepEqual(offer.click.visibleMatch, { role: 'button', name: 'See the offer', steadiest: { kind: 'id', selector: '#twin-a' } });
    assert.match(offer.reason, /the first of its 2 matches is hidden, and the first is the one clicked — #twin-a finds the one shown/);
  });

  test('the page\'s own beacon is not held against a state; a payment the click starts is', async () => {
    const { screens, summary } = await checkStates(urlOf('stopped.html'), parseStates([
      { name: 'shipping', click: '#shipping', close: '#shipping' },
      { name: 'tip', click: '#tip' },
    ]), { formFactors: ['mobile'] });
    const [shipping, tip] = screens.mobile.states;
    assert.equal(shipping.reached, true);
    assert.ok(shipping.newText.includes('Free from 50 €.'));
    // Its own trigger closes it: the page is back, give or take its
    // aria-expanded.
    assert.equal(shipping.close.closed, true);
    assert.deepEqual({ reached: tip.reached, step: tip.step, stopped: tip.stopped }, { reached: false, step: 'guards', stopped: ['POST /api/payment/tip'] });
    assert.equal(summary.ok, false);
  });
});
