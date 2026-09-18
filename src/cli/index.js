import { parseArgs } from 'node:util';
import { version } from '../version.js';
import { runAuditCommand, parseRuns, parseFailOn, EXIT, UsageError } from './audit-command.js';

const OPTIONS = {
  baseline: { type: 'string', short: 'b' },
  runs: { type: 'string', short: 'r' },
  config: { type: 'string', short: 'c' },
  'fail-on': { type: 'string' },
  json: { type: 'boolean' },
  out: { type: 'string', short: 'o', multiple: true },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const USAGE = `Kanso — frontend audits, on your machine

  kanso audit [url | dir] [options]
  kanso mcp

Audits a page on mobile and desktop and judges it against your budgets, or
against a baseline page when you name one. The page is a URL, or a directory
of built files that Kanso serves itself for the length of the audit. Name
neither, and Kanso serves the project the way the serve: block of its
.kanso.yml says. \`audit\` may be left out when the first argument is a URL.

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
export async function main(argv, { io = process, cwd = process.cwd(), runLighthouse } = {}) {
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
    if (head !== 'audit' && head !== 'mcp' && !head.includes('://')) throw new UsageError(`unknown command: ${head}`);

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
