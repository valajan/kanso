// What the explorer may touch. Read-only: it clicks, scrolls and presses keys
// on the page it was given, and nothing else — no field typed in, no form
// sent, no other page opened. The rules are code, and a model never sees an
// element they refuse: what it cannot choose it cannot click.
//
// Two layers. `verdict` rules on an element from what the snapshot read of
// it, before anything is clicked. `guardPage` is the net under it, for what no
// markup announces: a button whose script posts, or navigates, is stopped at
// the network.

// A name that says the click does something that cannot be taken back: one
// that starts with the verb, as a button naming its action does. A net, not a
// judgment: a harmless button caught here is a state left unexplored, which is
// the cheap mistake — but the verb anywhere in the name caught "What will you
// send me?", a question that only opens a panel.
const DESTRUCTIVE = /^\W*(delete|remove|log ?out|sign ?out|unsubscribe|buy|purchase|checkout|pay|place order|send|submit|confirm|supprimer|retirer|d[ée]connexion|se d[ée]connecter|acheter|payer|commander|envoyer|valider|confirmer)\b/i;

// Roles whose click changes a value rather than what is shown.
const VALUE_ROLES = new Set(['checkbox', 'radio', 'switch', 'option', 'slider', 'spinbutton', 'menuitemcheckbox', 'menuitemradio', 'textbox', 'searchbox']);

// { ok: true } or { ok: false, reason }. `pageUrl` is the page being
// explored: a link is allowed only when it stays on it.
export function verdict(element, pageUrl) {
  if (element.disabled) return refuse('disabled');
  if (element.editable) return refuse('a field: nothing is typed in read-only mode');
  if (VALUE_ROLES.has(element.role)) return refuse(`a ${element.role}: its click changes a value`);
  if (['submit', 'image'].includes(element.type) && (element.inForm || element.tag === 'input')) return refuse('sends a form');
  if (element.type === 'reset') return refuse('resets a form');
  if (DESTRUCTIVE.test(element.name)) return refuse(`named "${element.name}"`);

  if (element.href !== null) {
    const link = linkVerdict(element, pageUrl);
    if (!link.ok) return link;
  }
  return { ok: true };
}

function linkVerdict({ href, rawHref, target, download }, pageUrl) {
  if (download) return refuse('downloads a file');
  if (target && !['_self', ''].includes(target)) return refuse('opens another tab');
  if (/^\s*javascript:/i.test(rawHref ?? '')) return { ok: true };
  let to;
  try {
    to = new URL(href);
  } catch {
    return refuse('an address that does not parse');
  }
  if (!['http:', 'https:'].includes(to.protocol)) return refuse(`leaves the page (${to.protocol})`);
  const from = new URL(pageUrl);
  if (to.origin !== from.origin) return refuse('leaves the site');
  if (to.pathname !== from.pathname || to.search !== from.search) return refuse('goes to another page');
  // The same page with no fragment to jump to is the page loaded again.
  if (!to.hash) return refuse('reloads the page');
  return { ok: true };
}

function refuse(reason) {
  return { ok: false, reason };
}

// Methods that only read. Anything else is a write, and is stopped.
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Guards `page` while it is explored: a navigation of the main frame away from
// the document being explored, a request that writes, a window opened and a
// dialog raised are all stopped, and recorded in `blocked`. `allow(url)` lets
// the explorer's own navigation through — the load it starts from — until
// `allow(null)` closes the door again, once that load is done.
export async function guardPage(page) {
  const blocked = [];
  let expected = null;
  // The document an address names, as Chrome writes it: `https://a.com`
  // is requested as `https://a.com/`, and must not be stopped for it.
  const doc = (url) => {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return url.split('#')[0];
    }
  };

  await page.setRequestInterception(true);
  const onRequest = (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const url = request.url();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      if (expected !== null && doc(url) === doc(expected)) return request.continue();
      blocked.push({ kind: 'navigation', url });
      // A 204 cancels a navigation and leaves the page where it was; an abort
      // would swap it for Chrome's error page.
      return request.respond({ status: 204, body: '' });
    }
    if (!READS.has(request.method())) {
      blocked.push({ kind: 'write', method: request.method(), url });
      return request.abort('blockedbyclient');
    }
    return request.continue();
  };
  const onPopup = (popup) => {
    blocked.push({ kind: 'window', url: popup?.url() ?? null });
    popup?.close().catch(() => {});
  };
  const onDialog = (dialog) => {
    blocked.push({ kind: 'dialog', type: dialog.type(), message: dialog.message() });
    dialog.dismiss().catch(() => {});
  };
  page.on('request', onRequest);
  page.on('popup', onPopup);
  page.on('dialog', onDialog);

  return {
    blocked,
    allow(url) {
      expected = url;
    },
    async dispose() {
      page.off('request', onRequest);
      page.off('popup', onPopup);
      page.off('dialog', onDialog);
      await page.setRequestInterception(false).catch(() => {});
    },
  };
}

// What the guards stopped that a click did, out of all they stopped while it
// was being judged: every navigation, window and dialog, and every write the
// page does not also make on its own. `unprompted` holds where the page
// writes with nothing clicked (`writeKey`), which ./page.js `prepare` gathers
// from its two first visits.
//
// A page's own beacons — an analytics POST, a `sendBeacon`, a heartbeat — go
// on whatever is clicked, and are stopped during any click that lasts long
// enough; counted, they would leave no click a state. They are told from the
// click's writes by where they go — method, origin and path, the query left
// out, since a beacon's query carries a timestamp or a counter and its path
// does not. A write a click makes to an address the page also writes to
// unprompted is lost among them: the price of keeping this simple, and a
// small one, for what a button writes to is its own endpoint, not the
// analytics one. A beacon slower than the two first visits goes unseen and
// counts against the click it lands in, which is the side to err on: a
// harmless state left unfound, rather than a write an audit replays. A
// navigation, a window or a dialog is never a page's background noise.
export function stoppedBy(blocked, unprompted = new Set()) {
  return blocked.filter((b) => b.kind !== 'write' || !unprompted.has(writeKey(b)));
}

// Where a write goes, as `stoppedBy` compares it.
export function writeKey({ method, url }) {
  try {
    const { origin, pathname } = new URL(url);
    return `${method} ${origin}${pathname}`;
  } catch {
    return `${method} ${url}`;
  }
}

// What was stopped, in a few words for a terminal: `POST /api/tip`,
// `navigation to /next.html`, `a window`, `confirm`. An address on the page's
// own origin by its path, another with its host.
export function describeStopped(b, pageUrl) {
  const where = (url) => {
    try {
      const to = new URL(url);
      return pageUrl && to.origin === new URL(pageUrl).origin ? to.pathname : `${to.host}${to.pathname}`;
    } catch {
      return url ?? '';
    }
  };
  if (b.kind === 'write') return `${b.method} ${where(b.url)}`;
  if (b.kind === 'navigation') return `navigation to ${where(b.url)}`;
  if (b.kind === 'window') return 'a window';
  if (b.kind === 'dialog') return b.type;
  return b.kind;
}
