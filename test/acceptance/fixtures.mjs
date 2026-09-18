import { randomBytes } from 'node:crypto';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// The preview host stand-in is the one `kanso audit <dir>` serves a build with.
export { serveDirectory } from '../../src/serve/static.js';

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

// Copies the build into `dir` and applies the fixture's regression.
export async function materialize(fixtureId, distDir, dir) {
  await cp(distDir, dir, { recursive: true });
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
