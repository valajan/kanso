// What a probe runs inside the page, and the helpers it runs with.
//
// A function handed to the page is sent as source and runs there, in the
// page's own world: it sees nothing of this module, so the helpers travel with
// it, as its first argument. The whole call goes as one expression, evaluated
// through the DevTools protocol — which no Content-Security-Policy of the page
// can refuse, where an `eval` inside the page could be.

// Runs `fn(dom, ...args)` in the page and resolves to what it returns, awaited.
// `args` must survive JSON.
export function inPage(page, fn, ...args) {
  const call = [DOM, ...args.map((arg) => JSON.stringify(arg))].join(', ');
  return page.evaluate(`(${fn})(${call})`);
}

// An element as Kanso reports one — the fields src/modules/findings.js lists —
// computed the way Lighthouse computes them for the elements it reports, so
// that a probe's elements read like everyone else's. `path` follows
// Lighthouse's format, and tells two elements apart across form factors.
function describe(element) {
  return { selector: selector(element), snippet: snippet(element), label: label(element), path: path(element) };

  // Up to four levels, each by its id, else its first class.
  function selector(node) {
    const parts = [];
    while (node && parts.length < 4) {
      let part = node.localName;
      if (node.id) part += '#' + node.id;
      else if (node.classList?.length > 0) part += '.' + node.classList[0];
      parts.unshift(part);
      node = node.parentElement;
      if (!node || node.localName === 'html') break;
    }
    return parts.join(' > ');
  }

  // Its opening tag, long attribute values cut.
  function snippet(node) {
    const clone = node.cloneNode(false);
    for (const attr of [...clone.attributes]) {
      if (attr.value.length > 75) clone.setAttribute(attr.name, attr.value.slice(0, 74) + '…');
    }
    const html = clone.outerHTML;
    const open = html.slice(0, html.indexOf('>') + 1);
    return open.length > 500 ? open.slice(0, 499) + '…' : open;
  }

  // Its text, else what names it.
  function label(node) {
    const text = (node.innerText || node.getAttribute('aria-label') || node.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
    return text.length > 80 ? text.slice(0, 79) + '…' : text;
  }

  // Index and name of every node from the document down, as Lighthouse writes
  // them: blank text between two tags does not count.
  function path(node) {
    const steps = [];
    while (node && node.parentNode) {
      let index = 0;
      for (let prev = node.previousSibling; prev; prev = prev.previousSibling) {
        if (prev.nodeType === Node.TEXT_NODE && !(prev.nodeValue ?? '').trim()) continue;
        index++;
      }
      steps.unshift(`${index},${node.nodeName}`);
      node = node.parentNode;
    }
    return steps.join(',');
  }
}

// Whether `element` is a modal dialog: `dialog:modal` — a <dialog> shown with
// showModal(), which makes the page behind it inert with no attribute to say
// so —, `aria-modal="true"`, or a dialog with the rest of the page hidden from
// assistive technology or made inert behind it, which is how Radix, Reka UI
// and their kin make one modal. The one reading of it that
// src/probes/transition.js tells what opened by and src/discover/ narrows what
// it reads to.
function modal(element) {
  if (element.matches('dialog:modal') || element.getAttribute('aria-modal') === 'true') return true;
  // Everything under <body> but what holds the dialog is hidden from
  // assistive technology, or inert — and some of it shows.
  const shows = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0);
  const behind = [...document.body.children].filter((el) => !['script', 'style', 'template', 'link', 'noscript'].includes(el.localName) && !el.contains(element));
  const hidden = (el) => el.getAttribute('aria-hidden') === 'true' || el.inert;
  return behind.some((el) => shows(el) && hidden(el)) && behind.every((el) => hidden(el) || !shows(el));
}

const DOM = `({ describe: ${describe}, modal: ${modal} })`;
