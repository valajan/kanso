import { randomBytes } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// Known-answer fixtures for the acceptance suite.
//
// Each fixture is the real kanso-frontend build with one deliberate regression
// injected into the prerendered index.html. Injecting after the build, rather
// than editing the Vue sources, keeps the suite independent of how the landing
// page is written and saves one Nuxt build per variant.
//
// Every regression is sized well above Lighthouse's run-to-run noise, so a
// failing assertion means Kanso missed something real — not that a run was
// unlucky.
export const FIXTURES = {
  baseline: {
    description: 'the build as shipped',
    apply: async () => {},
  },

  // A long task only counts toward TBT when it lands after first paint, so it
  // is deferred past `load`: run inline during parsing, it would delay FCP
  // instead. Under mobile emulation's 4x CPU slowdown, 300 ms becomes ~1.2 s.
  tbt: {
    description: 'a 300 ms main-thread busy loop after load',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html,
      '<script>addEventListener("load",function(){setTimeout(function(){var t=Date.now();while(Date.now()-t<300){}},50)})</script>'
    )),
  },

  // Pushes the whole page down after it has rendered — the late-inserted banner
  // pattern. Lighthouse keeps tracing past `load`, so the shift is recorded.
  cls: {
    description: 'a 400 px block inserted above the content after load',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html,
      '<script>addEventListener("load",function(){setTimeout(function(){var d=document.createElement("div");d.style.height="400px";document.body.insertBefore(d,document.body.firstChild)},100)})</script>'
    )),
  },

  // A block with a fixed width a phone does not have: the page scrolls sideways
  // at 320 CSS pixels, which is Kanso's reflow probe to catch — axe runs at one
  // width and cannot. Placed after the app, at the end of the page, so that no
  // metric moves.
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
  // the suite declares as a state; nothing Lighthouse measures moves, since
  // nobody clicks during a load.
  inp: {
    description: 'a click whose handler holds the main thread 800 ms',
    apply: (dir) => editIndex(dir, (html) => beforeBodyEnd(html, '<script>window.kansoAcceptanceHold=800</script>')),
  },

  // A multi-megabyte image as the first, largest element: the unoptimized hero.
  // Its pixels are random so no compression can shrink it, and explicit
  // dimensions keep it from also causing a layout shift.
  lcp: {
    description: 'an uncompressible 2.9 MB hero image',
    apply: async (dir) => {
      await writeFile(join(dir, 'kanso-acceptance-hero.png'), noisePng(800, 1200));
      await editIndex(dir, (html) => afterBodyOpen(html,
        '<img src="/kanso-acceptance-hero.png" width="800" height="1200" alt="" style="display:block;width:100%;height:auto">'
      ));
    },
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

// Copies the build into `dir`, gives it the violation and the button every
// fixture shares, and applies the fixture's own regression.
export async function materialize(fixtureId, distDir, dir) {
  await cp(distDir, dir, { recursive: true });
  await editIndex(dir, (html) => beforeBodyEnd(html, INHERITED + PRESS));
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

// --- PNG --------------------------------------------------------------------

// Encodes an RGB PNG of random noise. Written by hand because the suite should
// not grow an image dependency for one fixture.
export function noisePng(width, height) {
  const rowBytes = width * 3 + 1;
  const raw = randomBytes(rowBytes * height);
  for (let y = 0; y < height; y++) raw[y * rowBytes] = 0; // filter type: none

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  // compression, filter and interlace methods stay 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 0: random bytes do not compress, so skip the work of trying.
    chunk('IDAT', deflateSync(raw, { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
