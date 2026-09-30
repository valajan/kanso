import { version } from '../version.js';
import { createDispatcher, serve } from './protocol.js';
import { createTools } from './tools.js';

// Handed to the host's model, as a hint about what this server is for. Short on
// purpose: it is prompt, and every line of it is paid for on every turn.
const INSTRUCTIONS = `Kanso runs deterministic probes through a web page in Chrome — into the states it opens and out of them — and returns a verdict — pass, warn or fail — on what they found: what the page breaks for assistive technology and the keyboard, what opening and closing its states leaves behind, and how long a click takes to answer.

Use it to check a frontend change rather than describe one: build, then audit the build — the URL serving it, its directory, or no url at all when the project's .kanso.yml says how to serve it. Auditing a dev server measures the dev server, not the page a user gets.

An audit needs a baseline to tell a regression from a page's existing debt. When a before-and-after is available — the same build without the change, the main branch's preview, production — pass it as \`baseline\`.

Much of what an audit checks happens in the page's states — a menu opened, a dialog shown — and it only goes through the ones the project declares. When the page opens things on click and none are declared, or the change added one, read the source for what opens what and propose them to \`check_states\`: it replays each and says what holds.

A call takes 10 to 60 seconds per run and reports progress while it works.`;

// Serves MCP over a stream pair and resolves when the host closes the input.
// One call, one audit, no state between them: `src/core/audit.js` with a third
// entrance, after the CLI and the PR report.
//
// `input`/`output` are the process's own streams in production and fakes in the
// tests, which is what lets the protocol be exercised without a subprocess.
export async function runMcpServer({ input = process.stdin, output = process.stdout, cwd = process.cwd(), runLoads, checkStates } = {}) {
  const loads = runLoads ?? (await import('../runner/runner.js')).runLoads;
  const stream = protectStdout(output);

  const dispatch = createDispatcher({
    serverInfo: { name: 'kanso', title: 'Kanso', version: version() },
    instructions: INSTRUCTIONS,
    tools: createTools({ cwd, runLoads: loads, checkStates }),
  });

  await serve({ input, output: stream, dispatch });
}

// On stdio, every byte of stdout belongs to the protocol: one stray line — a
// dependency's console.log, a warning from a worker thread — lands in the
// middle of a JSON-RPC frame and the host drops the connection. Kanso audits a
// page by launching Chrome in worker threads, which is a lot of code to trust
// with that.
//
// So the frames go out through the write captured here, and everything else the
// process sends to stdout is diverted to stderr, where an MCP host shows it as
// server output rather than feeding it to a JSON parser.
function protectStdout(output) {
  if (output !== process.stdout) return output;

  const write = output.write.bind(output);
  output.write = (chunk, encoding, callback) => process.stderr.write(chunk, encoding, callback);
  return { write };
}
