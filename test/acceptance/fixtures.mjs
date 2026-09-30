import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Known-answer fixtures for the acceptance suite.
//
// Each fixture is the real kanso-landing build with one deliberate regression
// injected into the prerendered index.html. Injecting after the build, rather
// than editing the Vue sources, keeps the suite independent of how the landing
// page is written and saves one Nuxt build per variant.
//
// Every regression is sized well above run-to-run noise, so a failing
// assertion means Kanso missed something real — not that a run was unlucky.
export const FIXTURES = {
  baseline: {
    description: 'the build as shipped',
    apply: async () => {},
  },

  // A block with a fixed width a phone does not have: the page scrolls sideways
  // at 320 CSS pixels, which is Kanso's reflow probe to catch — axe runs at one
  // width and cannot. Placed after the app, at the end of the page, so that
  // nothing else moves.
  //
  // Wrapped in a named region, which is a landmark: text bolted onto the end of
  // a body belongs to no part of the page, and `region` would report it —
  // rightly, and beside the point. A fixture regresses one thing.
  reflow: {
    description: 'a block laid out 400 px wide at the end of the page',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html,
      '<section aria-label="Acceptance fixture"><div class="kanso-acceptance-wide" style="width:400px">A block laid out 400 pixels wide, whatever the screen</div></section>'
    )),
  },

  // The button every fixture carries (PRESS, below), made to hold the main
  // thread 800 ms when clicked: the heavy handler. INP is timed on the click
  // the suite declares as a state; nothing else moves.
  inp: {
    description: 'a click whose handler holds the main thread 800 ms',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html, '<script>window.kansoAcceptanceHold=800</script>')),
  },

  // The dialog every fixture carries (DIALOG, below), opened with the focus
  // left behind it — on the button that opened it, in a page a screen reader
  // is told is not there. The focus probe's to catch, going into the state
  // from the keyboard; nothing a load measures moves.
  focus: {
    description: 'a modal dialog that leaves focus behind it',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html, '<script>window.kansoAcceptanceDialog={focus:false}</script>')),
  },

  // The same dialog, closed without giving the page its scrolling back: the
  // `overflow: hidden` it puts on <body> while open stays. The residues probe's
  // to catch, comparing the page before and after.
  residue: {
    description: 'a modal dialog that leaves the page locked once closed',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html, '<script>window.kansoAcceptanceDialog={unlock:false}</script>')),
  },

};

// One violation every fixture carries, the baseline included: an image with no
// alternative text. It is `critical`, so it would fail any step it was new to —
// and it is new to none, which is the whole point. What it proves is the
// property the suite exists for: a finding the reference already has is never
// held against a change.
//
// It used to be proved by the landing page itself, which carried violations of
// its own. The day the page was fixed, the suite lost what it was reading and
// started failing on a page that had become perfect. A property of Kanso must
// not rest on a page staying imperfect.
const INHERITED = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="1" height="1">';

// A button every fixture carries, for INP to time: the suite declares its
// click as a state (PRESS_STATE), and says it was reached by aria-pressed.
// It answers at once, unless a fixture sets how long it holds the main thread
// first — which the `inp` fixture does. Carried by the baseline too, so that
// every step, and not only the one that regresses it, proves INP is measured.
//
// In a named region, like the reflow fixture's block: a button bolted onto the
// end of a body belongs to no part of the page, and `region` would say so.
const PRESS = '<section aria-label="Acceptance control"><button type="button" id="kanso-acceptance-press" aria-pressed="false">Press</button></section>'
  + '<script>(function(){var b=document.getElementById("kanso-acceptance-press");b.addEventListener("click",function(){var t=Date.now(),h=window.kansoAcceptanceHold||0;while(Date.now()-t<h){}b.setAttribute("aria-pressed","true")})})()</script>';

export const PRESS_STATE = {
  name: 'press',
  click: '#kanso-acceptance-press',
  wait_for: "#kanso-acceptance-press[aria-pressed='true']",
};

// A modal dialog every fixture carries, declared as a state after the button
// (DIALOG_STATE), for the probes that go into and out of a state: focus, what
// is left behind, what memory keeps. Done right by default — focus moved in
// and held there, the page locked and hidden behind it, Escape closing it and
// giving all of it back, focus returned — and a fixture may undo one part of
// it (`window.kansoAcceptanceDialog`): `focus` and `residue` do.
const DIALOG = '<section aria-label="Acceptance dialog"><button type="button" id="kanso-acceptance-dialog-open">Open the dialog</button>'
  + '<div id="kanso-acceptance-dialog" role="dialog" aria-modal="true" aria-label="Acceptance dialog" hidden style="position:fixed;inset:20% 10%;background:#fff;color:#111;padding:1rem;z-index:1000">'
  + '<button type="button" id="kanso-acceptance-dialog-ok">OK</button></div></section>'
  + '<script>(function(){var o=document.getElementById("kanso-acceptance-dialog-open"),d=document.getElementById("kanso-acceptance-dialog"),k=document.getElementById("kanso-acceptance-dialog-ok");'
  + 'function c(){var f=window.kansoAcceptanceDialog||{};d.hidden=true;if(f.unlock!==false)document.body.style.overflow="";o.focus()}'
  + 'o.addEventListener("click",function(){var f=window.kansoAcceptanceDialog||{};d.hidden=false;document.body.style.overflow="hidden";if(f.focus!==false)k.focus()});'
  + 'd.addEventListener("keydown",function(e){if(e.key==="Tab"){e.preventDefault();k.focus()}});'
  + 'document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!d.hidden)c()})})()</script>';

export const DIALOG_STATE = {
  name: 'dialog',
  click: '#kanso-acceptance-dialog-open',
  wait_for: '#kanso-acceptance-dialog:not([hidden])',
};

// Copies the build into `dir`, gives it the violation, the button and the
// dialog every fixture shares, and applies the fixture's own regression.
export async function materialize(fixtureId, distDir, dir) {
  await cp(distDir, dir, { recursive: true });
  // The dialog at the top, away from the end of the page: where the button's
  // click scrolls to, and where what the fixtures add lands, stays what it was
  // before there was a dialog — and so does what axe can and cannot decide
  // there, which a line more at the end was enough to change.
  await editIndex(dir, (html) => afterBodyOpen(beforeBodyEnd(html, INHERITED + PRESS), DIALOG));
  await FIXTURES[fixtureId].apply(dir);
}

// --- HTML injection ---------------------------------------------------------

async function editIndex(dir, transform) {
  const file = join(dir, 'index.html');
  await writeFile(file, transform(await readFile(file, 'utf8')));
}

// Both helpers throw when their anchor is missing: a fixture that silently
// fails to inject would turn every regression test into a false pass.
function afterBodyOpen(html, snippet) {
  const match = html.match(/<body[^>]*>/i);
  if (!match) throw new Error('index.html has no <body> tag to inject after');
  const at = match.index + match[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function beforeBodyEnd(html, snippet) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  if (at === -1) throw new Error('index.html has no </body> tag to inject before');
  return html.slice(0, at) + snippet + html.slice(at);
}
