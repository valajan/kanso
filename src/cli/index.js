import { parseArgs } from 'node:util';
import { version } from '../version.js';
import { runAuditCommand, parseRuns, parseFailOn, EXIT, UsageError } from './audit-command.js';
import { runDiscoverCommand } from './discover-command.js';

const OPTIONS = {
  baseline: { type: 'string', short: 'b' },
  runs: { type: 'string', short: 'r' },
  config: { type: 'string', short: 'c' },
  'fail-on': { type: 'string' },
  json: { type: 'boolean' },
  out: { type: 'string', short: 'o', multiple: true },
  record: { type: 'string' },
  write: { type: 'boolean', short: 'w' },
  depth: { type: 'string' },
  'max-clicks': { type: 'string' },
  'form-factor': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const USAGE = `Kanso — frontend audits, on your machine

  kanso audit [url | dir] [options]
  kanso discover [url | dir] [--write]
  kanso mcp

Audits a page on mobile and desktop and judges it against your budgets, or
against a baseline page when you name one. The page is a URL, or a directory
of built files that Kanso serves itself for the length of the audit. Name
neither, and Kanso serves the project the way the serve: block of its
.kanso.yml says. \`audit\` may be left out when the first argument is a URL.

\`kanso discover\` finds the states of the page — a menu, a dialog, a tab — by
clicking through it, two clicks deep, on mobile and desktop, without typing,
sending or leaving it. It prints them, or, with --write, writes them to
.kanso/states.yml beside .kanso.yml — rewritten whole each time, and read with
it. .kanso.yml is never touched: a state written by hand there is kept, and
wins over a found one. Each state found is reached a second time before it is
kept.

\`kanso mcp\` serves the same audit to a coding agent over MCP, on stdin and
stdout, so the agent that just wrote the code can measure it. It reads the
project configuration from the directory it is started in.

Options
  -b, --baseline <url | dir>
                        page to compare against: production, the main branch's
                        preview, or a second local build
  -r, --runs <n>        loads per page and form factor, 1-5. Lighthouse swings
                        by 20-30% on TBT, so several runs and their median is
                        what makes a small regression believable
  -c, --config <path>   configuration file (default: .kanso.yml, if present)
      --fail-on <level> exit 1 from this level up: warn or fail (default: fail)
      --json            print the whole result as JSON, and nothing else
  -o, --out <file>      also write the result to a file: the Markdown report
                        for a .md, the JSON for a .json. Repeatable
      --record <dir>    keep a journal of what the probes did on each load —
                        one JSON Lines file per load, beside the result as
                        audit.json — to look at, share or analyse

Options for discover
  -w, --write           write the states found to .kanso/states.yml, beside
                        .kanso.yml (or --config)
      --depth <n>       clicks deep, 1-3 (default: 2)
      --max-clicks <n>  clicks per screen before stopping (default: 60)
      --form-factor <mobile | desktop>
                        explore one screen only (default: both)
      --json            print what was found as JSON

  -h, --help            print this
  -v, --version         print the version

Exit codes
  0  audited, and nothing reached --fail-on
  1  audited, and something did
  2  the audit could not run
`;

// Parses the command line and runs the requested command, returning the
// process exit code. Nothing here writes to the real stdio or reads the real
// argv, so the CLI is exercised in the tests exactly as a user runs it.
export async function main(argv, { io = process, cwd = process.cwd(), runLighthouse, discover } = {}) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });

    if (values.version) {
      io.stdout.write(version() + '\n');
      return EXIT.ok;
    }
    if (values.help) {
      io.stdout.write(USAGE);
      return EXIT.ok;
    }
    if (positionals.length === 0) {
      io.stderr.write(USAGE);
      return EXIT.error;
    }

    // `kanso audit <url>` and `kanso <url>` are the same command.
    const [head, ...rest] = positionals;
    if (!['audit', 'discover', 'mcp'].includes(head) && !head.includes('://')) throw new UsageError(`unknown command: ${head}`);

    const discoverOnly = ['write', 'depth', 'max-clicks', 'form-factor'].filter((key) => key in values);
    if (head === 'discover') {
      const auditOnly = ['baseline', 'runs', 'fail-on', 'out', 'record'].filter((key) => key in values);
      if (auditOnly.length > 0) throw new UsageError(`discover takes no --${auditOnly[0]}: that is an audit's`);
      if (rest.length > 1) throw new UsageError(`discover takes one page, got ${rest.length}`);
      return await runDiscoverCommand({
        target: rest[0] ?? null,
        configPath: values.config ?? null,
        write: Boolean(values.write),
        json: Boolean(values.json),
        maxDepth: values.depth == null ? undefined : whole(values.depth, 'depth', 1, 3),
        maxClicks: values['max-clicks'] == null ? undefined : whole(values['max-clicks'], 'max-clicks', 1, 500),
        formFactors: values['form-factor'] == null ? undefined : [formFactor(values['form-factor'])],
        cwd,
        io,
        discover,
      });
    }
    if (discoverOnly.length > 0) throw new UsageError(`--${discoverOnly[0]} is discover's, not ${head === 'mcp' ? 'mcp' : 'an audit'}'s`);

    const lighthouse = runLighthouse ?? (await import('../lighthouse/runner.js')).runLighthouse;

    if (head === 'mcp') {
      // Every option above belongs to one audit, and an MCP client passes them
      // call by call — accepting them here would silently fix what the agent
      // is meant to choose.
      if (rest.length > 0) throw new UsageError(`mcp takes no arguments, got ${rest.join(' ')}`);
      if (Object.keys(values).length > 0) throw new UsageError('mcp takes no options: an MCP client passes them call by call');

      const { runMcpServer } = await import('../mcp/index.js');
      // The server answers until the host closes stdin.
      await runMcpServer({ input: io.stdin, output: io.stdout, cwd, runLighthouse: lighthouse });
      return EXIT.ok;
    }

    const args = head === 'audit' ? rest : positionals;
    if (args.length > 1) throw new UsageError(`audit takes one page, got ${args.length}`);

    return await runAuditCommand({
      target: args[0] ?? null,
      baseline: values.baseline ?? null,
      runs: values.runs == null ? null : parseRuns(values.runs),
      configPath: values.config ?? null,
      failOn: parseFailOn(values['fail-on'] ?? 'fail'),
      json: Boolean(values.json),
      out: values.out ?? [],
      record: values.record ?? null,
      cwd,
      io,
      runLighthouse: lighthouse,
    });
  } catch (err) {
    const usage = err instanceof UsageError || err?.code?.startsWith?.('ERR_PARSE_ARGS');
    io.stderr.write(`kanso: ${err.message}\n${usage ? 'Try `kanso --help`.\n' : ''}`);
    return EXIT.error;
  }
}

function whole(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number between ${min} and ${max}`);
  return n;
}

function formFactor(value) {
  if (!['mobile', 'desktop'].includes(value)) throw new UsageError('--form-factor must be mobile or desktop');
  return value;
}
