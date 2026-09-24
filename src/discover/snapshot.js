import { inPage } from '../probes/dom.js';

// What a page offers to be clicked, read in one call from inside it: every
// interactive element a visitor can see — anywhere on the page, not only in
// the viewport — with the role, name and state a screen reader would give it,
// and what the fingerprint and the selectors are built from.
//
// The elements are kept, in page order, under Symbol.for('kanso.discover'):
// the element numbered `i` is `nodes[i]`, which is how a selector computed on
// this side is checked to point back at it (./selectors.js).
//
// While a modal dialog is open, the page is that dialog: what is read — its
// controls, its dialogs, its text — is what is inside it, and nothing of the
// page behind. A visitor can reach nothing else, and what is behind says
// nothing of the state: a dialog opened from the header's account button,
// which says it is expanded, and the same dialog opened from a button in the
// page, which says nothing, are one state — which a reading of the whole page,
// the button's `aria-expanded` in it, would take for two. showModal() makes
// the page behind inert with no attribute to say so, which is why it is not
// enough to leave out what is `[inert]`. A modal already open as the page
// loads — a consent dialog — is the page as it loads, and narrows nothing:
// the page is explored behind it, as it was before (`markLoaded`).

// More than this, and a page is mostly a list of links: three hundred of them
// are not three hundred states.
const MAX_ELEMENTS = 250;

export function snapshot(page, { maxElements = MAX_ELEMENTS } = {}) {
  return inPage(page, read, { maxElements });
}

// The modal dialogs open as the page has just loaded, kept in it: the ones a
// reading is never narrowed to.
export function markLoaded(page) {
  return inPage(page, (dom) => {
    const shows = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const open = [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')].filter((d) => shows(d) && dom.modal(d));
    window[Symbol.for('kanso.discover.loaded')] = new WeakSet(open);
  });
}

// Runs in the page.
function read(dom, { maxElements }) {
  const store = (window[Symbol.for('kanso.discover')] = { nodes: [] });

  const ROLES = [
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
    'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider',
  ];
  const SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]:not([tabindex^="-"])',
    '[aria-haspopup]:not([aria-haspopup="false"])', '[aria-expanded]', '[aria-controls]', '[onclick]',
    ...ROLES.map((role) => `[role="${role}"]`),
  ].join(',');

  const docWidth = document.documentElement.clientWidth;

  // The modal dialog open, if one is, that the page did not load with: where
  // focus is when more than one is, else the last.
  const loaded = window[Symbol.for('kanso.discover.loaded')];
  const modals = [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .filter((d) => !loaded?.has(d) && d.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && dom.modal(d));
  const scope = modals.filter((d) => d.contains(document.activeElement)).at(-1) ?? modals.at(-1) ?? null;

  // Seen by a visitor: rendered, not hidden from assistive technology, bigger
  // than the one-pixel box a visually hidden element is kept in, and not
  // parked off the side of the page the way an off-canvas menu waits — and,
  // while a modal dialog is open, inside it.
  function visible(e) {
    if (scope && !scope.contains(e)) return false;
    if (e.closest('[aria-hidden="true"],[inert]')) return false;
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = e.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    if (r.right <= 0 || r.left >= docWidth) return false;
    if (r.bottom + scrollY <= 0) return false;
    return true;
  }

  // The accessible name, as jev-ultrafast approximates it: not the full
  // algorithm, but what the common patterns need.
  function name(e, seen = new Set()) {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced
      || e.getAttribute('aria-label')
      || [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ')
      || (['button', 'submit', 'reset'].includes(e.type) && e.tagName === 'INPUT' ? e.value : '')
      || e.getAttribute('alt')
      || (e.tagName === 'INPUT' ? '' : [...e.childNodes].map((n) => {
        if (n.nodeType === Node.TEXT_NODE) return n.textContent;
        if (n.nodeType === Node.ELEMENT_NODE && n.getAttribute('aria-hidden') !== 'true') return name(n, seen);
        return '';
      }).join(' '))
      || e.getAttribute('title')
      || e.getAttribute('placeholder')
      || '';
  }
  const clean = (text, max) => {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  };

  function role(e) {
    const explicit = e.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    switch (e.tagName) {
      case 'A': return e.hasAttribute('href') ? 'link' : 'generic';
      case 'BUTTON': return 'button';
      case 'SUMMARY': return 'button';
      case 'SELECT': return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const type = e.type;
        if (['checkbox', 'radio'].includes(type)) return type;
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'number') return 'spinbutton';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
    }
    if (e.isContentEditable) return 'textbox';
    return 'generic';
  }

  // Where it sits: the nearest landmark or dialog, which is what tells two
  // "Menu" buttons apart.
  function region(e) {
    const scope = e.closest('dialog,[role="dialog"],[role="alertdialog"],nav,[role="navigation"],header,[role="banner"],footer,[role="contentinfo"],aside,[role="complementary"],form,[role="form"],main,[role="main"]');
    if (!scope) return null;
    const kind = scope.getAttribute('role') || scope.localName;
    const label = clean(scope.getAttribute('aria-label') || name(document.getElementById(scope.getAttribute('aria-labelledby') || '')), 40);
    return label ? `${kind} "${label}"` : kind;
  }

  // An id worth selecting by: one a build does not regenerate.
  function stableId(id) {
    if (!id || document.querySelectorAll(`#${CSS.escape(id)}`).length !== 1) return null;
    if (/:|\d{3,}|^[a-f0-9-]{8,}$|radix|headlessui|react-aria|^mui-|^ember\d|^yui_|^rc[-_]|^:r/i.test(id)) return null;
    return id;
  }

  // The path from the nearest element with a stable id: the selector of last
  // resort, and the one a markup change breaks first.
  function cssPath(e) {
    const parts = [];
    for (let node = e; node && node !== document.documentElement; node = node.parentElement) {
      const id = stableId(node.id);
      if (id) { parts.unshift(`#${CSS.escape(id)}`); break; }
      let part = node.localName;
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.localName === node.localName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  }

  // The ones matched by markup, plus what only a pointer cursor gives away: a
  // div with a click handler, which no attribute announces.
  const candidates = new Set(document.querySelectorAll(SELECTOR));
  for (const e of document.body.querySelectorAll('div,span,li,img,svg,p,h1,h2,h3,h4,h5,h6,label')) {
    if (candidates.has(e) || e.closest(SELECTOR)) continue;
    if (getComputedStyle(e).cursor !== 'pointer') continue;
    if (e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer') continue;
    candidates.add(e);
  }

  const elements = [];
  let omitted = 0;
  const all = [...candidates].filter(visible).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  for (const e of all) {
    if (elements.length >= maxElements) { omitted++; continue; }
    const index = elements.length;
    store.nodes.push(e);
    const states = {};
    for (const key of ['expanded', 'selected', 'checked', 'pressed', 'current', 'haspopup']) {
      const value = e.getAttribute(`aria-${key}`);
      if (value !== null) states[key] = value;
    }
    if (e.tagName === 'DETAILS' || e.tagName === 'SUMMARY') states.expanded = String(!!e.closest('details')?.open);
    if (e.tagName === 'INPUT' && ['checkbox', 'radio'].includes(e.type)) states.checked = String(e.checked);
    elements.push({
      index,
      tag: e.localName,
      role: role(e),
      name: clean(name(e), 120),
      states,
      region: region(e),
      inferred: !e.matches(SELECTOR),
      type: e.tagName === 'INPUT' || e.tagName === 'BUTTON' ? e.type : null,
      inForm: !!e.form,
      // A field takes what is typed in it; an <input> that is a button does
      // not, and is judged as a button (./guards.js).
      editable: e.isContentEditable || ['TEXTAREA', 'SELECT'].includes(e.tagName)
        || (e.tagName === 'INPUT' && !['button', 'submit', 'reset', 'image'].includes(e.type)),
      disabled: e.matches(':disabled') || !!e.closest('[aria-disabled="true"]'),
      href: e.tagName === 'A' && e.hasAttribute('href') ? e.href : null,
      rawHref: e.getAttribute('href'),
      target: e.getAttribute('target'),
      download: e.hasAttribute('download'),
      id: stableId(e.id),
      testId: e.getAttribute('data-testid') || e.getAttribute('data-test') || e.getAttribute('data-cy'),
      ariaLabel: e.getAttribute('aria-label'),
      controls: stableId(e.getAttribute('aria-controls')),
      title: e.getAttribute('title'),
      cssPath: cssPath(e),
    });
  }

  const dialogs = [...document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')]
    .filter((d) => d === scope || visible(d))
    .map((d) => clean(d.getAttribute('aria-label') || name(document.getElementById(d.getAttribute('aria-labelledby') || '')) || d.localName, 60));

  // Every line of text the page renders, top to bottom: what a tab switcher
  // that only swaps a panel's text changes, when no interactive element does.
  const lines = (scope ?? document.body).innerText.split('\n').map((l) => clean(l, 200)).filter(Boolean).slice(0, 5_000);

  return {
    url: location.href,
    dialogs,
    elements,
    omitted,
    lines,
  };
}
