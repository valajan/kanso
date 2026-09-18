import { moduleConfig } from '../config/module-config.js';
import { code, formatReport, REPORT_TITLE, reportScores } from '../report/comment.js';
import { siteName } from '../serve/index.js';

// The audit as Markdown: the report a pull request gets, under a header naming
// what was audited rather than a branch. `--out report.md` writes it, which is
// what a CI job summary shows — so a report reads the same wherever it lands.
export function renderMarkdown({ url, baseline, served = null, result, config = {} }) {
  if (!result.ok) return `## ${REPORT_TITLE}\n\n⚠️ The audit could not run: ${code(result.error)}\n`;

  const perf = result.modules.performance;
  const page = code(siteName(url, served?.url));
  const header = baseline ? `🔗 ${page} against ${code(siteName(baseline, served?.baseline))}` : `🔗 ${page}`;

  return formatReport(reportScores(perf?.scores), {
    header,
    budget: moduleConfig(config, 'performance').budgets ?? {},
    referenceKind: perf?.referenceKind,
    refLabel: perf?.referenceKind === 'budgets' ? 'budget' : 'baseline',
    currentLabel: 'current',
    baseRef: 'baseline',
    modules: result.modules,
  });
}
