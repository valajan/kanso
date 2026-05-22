import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { App } from '@octokit/app';
import yaml from 'js-yaml';
import { runLighthouse } from './lighthouse.js';
import {
  analyzePerformanceRegression,
  detectSignificantRegressions,
  formatPendingNote,
  replaceAnalysisSection,
  metricLabels,
} from './src/ai-analysis/index.js';

const APP_ID = process.env.GITHUB_APP_ID;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const PRIVATE_KEY_PATH = process.env.GITHUB_PRIVATE_KEY_PATH;
const PORT = Number(process.env.PORT ?? 3000);

if (!APP_ID || !WEBHOOK_SECRET || !PRIVATE_KEY_PATH) {
  throw new Error('Missing env vars: GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET, GITHUB_PRIVATE_KEY_PATH');
}

const staticConfig = yaml.load(readFileSync('./config.yml', 'utf8'));

if (!staticConfig.base_url) throw new Error('Missing config: base_url');

// Deep-merge repo config on top of static defaults.
// budgets keys are merged individually so a client can override just one metric.
function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    budgets: { ...(base.budgets ?? {}), ...(override.budgets ?? {}) },
  };
}

// Fetches .perfguard.yml from the client repo and merges with staticConfig.
// Falls back to staticConfig silently if the file is absent.
async function loadRepoConfig(octokit, owner, repo, log, ref) {
  try {
    const { data } = await octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner, repo, path: '.perfguard.yml', ...(ref ? { ref } : {}) }
    );
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const repoConfig = yaml.load(content) ?? {};
    return mergeConfig(staticConfig, repoConfig);
  } catch (err) {
    if (err.status === 404) return staticConfig;
    // 403 = app lacks Contents read permission; fall back rather than crashing
    if (err.status === 403) {
      log?.warn(`${owner}/${repo} — no Contents permission, using default config`);
      return staticConfig;
    }
    throw err;
  }
}

const privateKey = readFileSync(PRIVATE_KEY_PATH, 'utf8');
const githubApp = new App({ appId: APP_ID, privateKey });
const previewUrls = new Map();
const pendingPRs = new Map();
const waitingComments = new Map();
const seenCheckRuns = new Set();
const seenRailwayDeployments = new Set();

const fastify = Fastify({
  disableRequestLogging: true,
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: '{msg}',
      },
    },
  },
});

fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => {
    req.rawBody = body;
    try {
      done(null, body.length === 0 ? {} : JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err);
    }
  }
);

function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  const expected =
    'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const sig = Buffer.from(signatureHeader);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length) return false;
  return timingSafeEqual(sig, exp);
}

// 'fail'  = PR exceeds the budget (if set) or the Lighthouse "poor" threshold → block merge
// 'warn'  = PR is in the Lighthouse "needs improvement" zone (between good and the fail threshold)
// 'pass'  = PR is in the Lighthouse "good" zone
// goodThreshold: Lighthouse "good/needs-improvement" boundary (fixed per metric)
// poorThreshold: Lighthouse "poor" boundary — used as fail threshold when no budget is set
function buildStatus(prVal, budgetVal, lowerIsBetter, goodThreshold, poorThreshold) {
  const failThreshold = budgetVal ?? poorThreshold;
  if (lowerIsBetter ? prVal > failThreshold : prVal < failThreshold) return 'fail';
  if (lowerIsBetter ? prVal > goodThreshold : prVal < goodThreshold) return 'warn';
  return 'pass';
}

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

function formatDelta(delta, { unit = '', decimals = 0 } = {}) {
  return (delta >= 0 ? '+' : '') + delta.toFixed(decimals) + unit;
}

function roundScoreToDisplay(score) {
  if (score == null) return null;
  return {
    performance: score.performance,
    lcp: parseFloat(score.lcp.toFixed(1)),
    tbt: Math.round(score.tbt),
    cls: parseFloat(score.cls.toFixed(2)),
    fcp: parseFloat(score.fcp.toFixed(1)),
  };
}

function detectSource(context, targetUrl) {
  const ctx = (context ?? '').toLowerCase();
  if (ctx.includes('cloudflare')) return 'Cloudflare Pages';
  if (ctx.includes('vercel')) return 'Vercel Preview';
  if (ctx.includes('netlify')) return 'Netlify Preview';
  if ((targetUrl ?? '').includes('.onrender.com')) return 'Render Preview';
  return 'Preview';
}

// Extracts a Cloudflare preview URL (*.pages.dev or *.workers.dev) from a check_run summary.
function extractCloudflarePreviewUrl(summary) {
  const match = (summary ?? '').match(/https:\/\/[^\s)>\]"']+\.(?:pages|workers)\.dev\b[^\s)>\]"']*/);
  return match?.[0] ?? null;
}

function formatComment(prScore, refScore, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {} } = {}) {
  const pr = roundScoreToDisplay(prScore);
  const ref = roundScoreToDisplay(refScore);

  const headerLine = headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source} detected automatically`
    : `🔗 URL: ${previewUrl}`;

  const note = refScore == null && Object.keys(budget).length === 0
    ? '\n_No reference score for main yet — diff will appear once a PR is merged to main._\n'
    : '';

  const fmtRef = (val, decimals, unit) => val == null ? '—' : val.toFixed(decimals) + unit;

  const statuses = {
    performance: buildStatus(pr.performance, budget.performance ?? null, false, 90, 49),
    lcp: buildStatus(pr.lcp, budget.lcp ?? null, true, 2.5, 4.0),
    tbt: buildStatus(pr.tbt, budget.tbt ?? null, true, 200, 600),
    cls: buildStatus(pr.cls, budget.cls ?? null, true, 0.1, 0.25),
    fcp: buildStatus(pr.fcp, budget.fcp ?? null, true, 1.8, 3.0),
  };

  const lowerIsBetter = { performance: false, lcp: true, tbt: true, cls: true, fcp: true };

  const rawDeltas = ref != null ? {
    performance: pr.performance - ref.performance,
    lcp: pr.lcp - ref.lcp,
    tbt: pr.tbt - ref.tbt,
    cls: pr.cls - ref.cls,
    fcp: pr.fcp - ref.fcp,
  } : null;

  const deltas = rawDeltas != null ? {
    performance: formatDelta(rawDeltas.performance, { decimals: 0 }),
    lcp: formatDelta(rawDeltas.lcp, { unit: 's', decimals: 1 }),
    tbt: formatDelta(rawDeltas.tbt, { unit: 'ms', decimals: 0 }),
    cls: formatDelta(rawDeltas.cls, { decimals: 2 }),
    fcp: formatDelta(rawDeltas.fcp, { unit: 's', decimals: 1 }),
  } : null;

  const deltaCell = (key) => deltas?.[key] ?? '—';
  const iconCell = (key) => {
    if (rawDeltas != null) {
      const d = rawDeltas[key];
      if (lowerIsBetter[key] ? d < 0 : d > 0) return '🎉';
    }
    return STATUS_ICON[statuses[key]];
  };

  const table = [
    '| Metric | main | PR | Δ | |',
    '|---|---|---|---|---|',
    `| Performance | ${fmtRef(ref?.performance, 0, '')} | ${pr.performance} | ${deltaCell('performance')} | ${iconCell('performance')} |`,
    `| LCP | ${fmtRef(ref?.lcp, 1, 's')} | ${pr.lcp.toFixed(1)}s | ${deltaCell('lcp')} | ${iconCell('lcp')} |`,
    `| TBT | ${fmtRef(ref?.tbt, 0, 'ms')} | ${pr.tbt}ms | ${deltaCell('tbt')} | ${iconCell('tbt')} |`,
    `| CLS | ${fmtRef(ref?.cls, 2, '')} | ${pr.cls.toFixed(2)} | ${deltaCell('cls')} | ${iconCell('cls')} |`,
    `| FCP | ${fmtRef(ref?.fcp, 1, 's')} | ${pr.fcp.toFixed(1)}s | ${deltaCell('fcp')} | ${iconCell('fcp')} |`,
  ].join('\n');

  return `## PerfGuard | Performance Report

${headerLine}
${note}
${table}
`;
}

function commitStatusPayload(statuses) {
  const failedKeys = Object.entries(statuses).filter(([, s]) => s === 'fail').map(([k]) => k);
  const hasWarn = Object.values(statuses).some((s) => s === 'warn');
  if (failedKeys.length > 0) {
    return {
      state: 'failure',
      description: `Performance regression detected on ${metricLabels(failedKeys)}`,
    };
  }
  if (hasWarn) return { state: 'success', description: 'Minor regressions — review before merging' };
  return { state: 'success', description: 'All metrics within acceptable thresholds' };
}

async function handlePreviewUrl({ octokit, owner, repo, sha, targetUrl, source, log }) {
  const { data: prs } = await octokit.request(
    'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
    { owner, repo, commit_sha: sha }
  );
  const pr = prs.find((p) => p.state === 'open');
  if (!pr) return { ok: true, ignored: 'no open PR for sha' };

  // Netlify's target_url is build-specific, so a late-arriving status event for
  // a superseded commit would otherwise make us run Lighthouse against the old build.
  if (pr.head.sha !== sha) {
    log.info(`PR #${pr.number} — stale deployment ignored (${sha.slice(0, 7)} ≠ HEAD ${pr.head.sha.slice(0, 7)})`);
    return { ok: true, ignored: 'sha is not PR head' };
  }

  const prNumber = pr.number;
  previewUrls.set(prNumber, targetUrl);
  log.info(`PR #${prNumber} — ${source} preview ready: ${targetUrl}`);

  if (pendingPRs.has(prNumber)) {
    pendingPRs.delete(prNumber);
    const repoConfig = await loadRepoConfig(octokit, owner, repo, log, sha);
    const previewWaitMs = (repoConfig.preview_wait_seconds ?? 15) * 1000;
    log.info(`PR #${prNumber} — waiting ${previewWaitMs / 1000}s for assets to stabilize...`);
    await new Promise((resolve) => setTimeout(resolve, previewWaitMs));
    await runAndPostReport({
      octokit, owner, repo, prNumber, sha,
      headRef: pr.head.ref, baseRef: pr.base.ref,
      previewUrl: targetUrl, source, log, repoConfig,
    });
  }
  return { ok: true, pr: prNumber, target_url: targetUrl };
}

async function postOrEditComment({ octokit, owner, repo, prNumber, body }) {
  const waitingCommentId = waitingComments.get(prNumber);
  if (waitingCommentId != null) {
    waitingComments.delete(prNumber);
    await octokit.request(
      'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
      { owner, repo, comment_id: waitingCommentId, body }
    );
    return waitingCommentId;
  }
  const { data } = await octokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { owner, repo, issue_number: prNumber, body }
  );
  return data.id;
}

async function runAndPostReport({ octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, source, log, repoConfig }) {
  const budget = repoConfig.budgets ?? {};
  const aiAnalysisEnabled = repoConfig.ai_analysis === true;
  const baseUrl = repoConfig.base_url;

  let prScore;
  let mainRefScore = null;

  // Run sequentially: concurrent Lighthouse instances share Node's performance
  // namespace (via marky) and corrupt each other's marks.
  log.info(`PR #${prNumber} — Lighthouse auditing preview...`);
  const prResult = await runLighthouse(previewUrl).then(
    (v) => ({ status: 'fulfilled', value: v }),
    (e) => ({ status: 'rejected', reason: e }),
  );
  log.info(`PR #${prNumber} — Lighthouse auditing production reference...`);
  const refResult = await runLighthouse(baseUrl).then(
    (v) => ({ status: 'fulfilled', value: v }),
    (e) => ({ status: 'rejected', reason: e }),
  );

  if (prResult.status === 'rejected') {
    log.error(`PR #${prNumber} — Lighthouse failed on preview: ${prResult.reason.message}`);
    await postOrEditComment({
      octokit, owner, repo, prNumber,
      body: `⚠️ PerfGuard — Lighthouse analysis failed: \`${prResult.reason.message}\``,
    });
    return { ok: false, error: prResult.reason.message };
  }

  prScore = prResult.value;

  if (refResult.status === 'fulfilled') {
    mainRefScore = refResult.value;
  } else {
    log.warn(`PR #${prNumber} — Lighthouse failed on production reference, comparison unavailable: ${refResult.reason.message}`);
  }

  const prRounded = roundScoreToDisplay(prScore);
  const statuses = {
    performance: buildStatus(prRounded.performance, budget.performance ?? null, false, 90, 49),
    lcp: buildStatus(prRounded.lcp, budget.lcp ?? null, true, 2.5, 4.0),
    tbt: buildStatus(prRounded.tbt, budget.tbt ?? null, true, 200, 600),
    cls: buildStatus(prRounded.cls, budget.cls ?? null, true, 0.1, 0.25),
    fcp: buildStatus(prRounded.fcp, budget.fcp ?? null, true, 1.8, 3.0),
  };

  const baseBody = formatComment(prScore, mainRefScore, {
    previewUrl,
    headRef,
    baseRef,
    source,
    budget,
  });

  const regressions = detectSignificantRegressions({
    statuses, prScore, refScore: mainRefScore, budget,
  });

  const initialBody = aiAnalysisEnabled && regressions.length > 0
    ? baseBody + formatPendingNote(regressions.map((r) => r.metric))
    : baseBody;

  const commentId = await postOrEditComment({ octokit, owner, repo, prNumber, body: initialBody });

  if (sha) {
    const { state, description } = commitStatusPayload(statuses);
    await octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
      owner, repo, sha,
      state,
      description,
      context: 'perfguard',
    }).catch((err) => log.warn(`PR #${prNumber} — failed to post commit status: ${err.message}`));
  }

  if (aiAnalysisEnabled && regressions.length > 0) {
    analyzePerformanceRegression({
      octokit, owner, repo, prNumber, sha, regressions, log,
    })
      .then(async (result) => {
        if (!result?.section) return;
        const updatedBody = replaceAnalysisSection(initialBody, result.section);
        await octokit.request(
          'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          { owner, repo, comment_id: commentId, body: updatedBody }
        );
        const n = result.structured?.comments?.length ?? 0;
        log.info(`PR #${prNumber} — AI analysis posted (${n} inline comment${n !== 1 ? 's' : ''})`);
      })
      .catch((err) => log.warn(`PR #${prNumber} — AI analysis failed: ${err.message}`));
  }

  const icon = Object.values(statuses).includes('fail') ? '❌' : Object.values(statuses).includes('warn') ? '⚠️' : '✅';
  log.info(
    `PR #${prNumber} ${icon} report posted — ` +
    `perf: ${prScore.performance} | LCP: ${prScore.lcp.toFixed(1)}s | TBT: ${Math.round(prScore.tbt)}ms | CLS: ${prScore.cls.toFixed(2)} | FCP: ${prScore.fcp.toFixed(1)}s`
  );
  return { ok: true, prScore };
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post('/webhook', async (req, reply) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];

  if (!verifySignature(req.rawBody, signature)) {
    req.log.warn(`Webhook rejected — invalid signature [${event} delivery:${delivery}]`);
    return reply.code(401).send({ error: 'invalid signature' });
  }

  const payload = req.body;

  if (event === 'ping') {
    return { ok: true, pong: true };
  }

  if (event === 'status' || event === 'deployment_status') {
    const isStatus = event === 'status';
    const state = isStatus ? payload.state : payload.deployment_status?.state;
    const targetUrl = isStatus
      ? payload.target_url
      : (payload.deployment_status?.environment_url || payload.deployment_status?.target_url);
    const sha = isStatus ? payload.sha : payload.deployment?.sha;
    const context = isStatus ? (payload.context ?? '') : (payload.deployment?.environment ?? '');

    if (isStatus && !context.toLowerCase().includes('netlify')) {
      return { ok: true, ignored: 'status not from netlify' };
    }
    if (state !== 'success' || !targetUrl || !sha) {
      return { ok: true, ignored_state: state };
    }
    if (!isStatus && (targetUrl ?? '').includes('railway.com')) {
      return { ok: true, ignored: 'railway deployment_status (target is dashboard, not preview)' };
    }

    const installationId = payload.installation?.id;
    if (!installationId) {
      return reply.code(400).send({ error: 'missing installation id' });
    }

    const octokit = await githubApp.getInstallationOctokit(installationId);
    return handlePreviewUrl({
      octokit,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      sha,
      targetUrl,
      source: detectSource(context, targetUrl),
      log: req.log,
    });
  }

  if (event === 'check_run') {
    const checkRun = payload.check_run;
    const appName = (checkRun?.app?.name ?? '').toLowerCase();
    const appSlug = (checkRun?.app?.slug ?? '').toLowerCase();
    const checkName = (checkRun?.name ?? '').toLowerCase();

    const isCloudflare = appName.includes('cloudflare') || appSlug.includes('cloudflare');
    const isAmplify = checkName.includes('amplify') || appName.includes('amplify');

    if (!isCloudflare && !isAmplify) {
      return { ok: true, ignored: 'check_run not from cloudflare or amplify' };
    }
    if (checkRun.status !== 'completed' || checkRun.conclusion !== 'success') {
      return { ok: true, ignored_conclusion: checkRun.conclusion };
    }
    if (seenCheckRuns.has(checkRun.id)) {
      return { ok: true, ignored: 'duplicate check_run' };
    }
    seenCheckRuns.add(checkRun.id);

    let targetUrl, source;
    if (isCloudflare) {
      targetUrl = extractCloudflarePreviewUrl(checkRun.output?.summary);
      source = 'Cloudflare Pages';
      if (!targetUrl) {
        req.log.warn('Cloudflare Pages check_run: no preview URL (.pages.dev / .workers.dev) found in summary');
        return { ok: true, ignored: 'no cloudflare preview URL in check_run summary' };
      }
    } else {
      targetUrl = checkRun.details_url;
      source = 'AWS Amplify';
      if (!targetUrl?.includes('.amplifyapp.com')) {
        req.log.warn('AWS Amplify check_run: no .amplifyapp.com URL found in details_url');
        return { ok: true, ignored: 'no amplify preview URL in check_run details_url' };
      }
    }

    const sha = checkRun.head_sha;
    const installationId = payload.installation?.id;
    if (!installationId) {
      return reply.code(400).send({ error: 'missing installation id' });
    }

    const octokit = await githubApp.getInstallationOctokit(installationId);
    return handlePreviewUrl({
      octokit,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      sha,
      targetUrl,
      source,
      log: req.log,
    });
  }

  if (event === 'issue_comment') {
    if (payload.action !== 'created' && payload.action !== 'edited') return { ok: true, ignored_action: payload.action };
    if (!payload.issue?.pull_request) return { ok: true, ignored: 'not a PR comment' };

    const commenter = (payload.comment?.user?.login ?? '').toLowerCase();
    if (!commenter.includes('railway')) return { ok: true, ignored: 'not railway bot' };

    const body = payload.comment?.body ?? '';
    if (!body.includes('✅')) return { ok: true, ignored: 'railway deployment not yet successful' };

    const match = body.match(/https:\/\/[^\s)>\]"]+\.up\.railway\.app\b[^\s)>\]"]*/);
    if (!match) {
      req.log.warn('Railway bot comment: no .up.railway.app URL found');
      return { ok: true, ignored: 'no railway preview URL in comment' };
    }

    const targetUrl = match[0];
    const prNumber = payload.issue.number;
    const installationId = payload.installation?.id;
    if (!installationId) return reply.code(400).send({ error: 'missing installation id' });

    const octokit = await githubApp.getInstallationOctokit(installationId);
    const { data: pr } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner: payload.repository.owner.login, repo: payload.repository.name, pull_number: prNumber }
    );
    if (pr.state !== 'open') return { ok: true, ignored: 'PR not open' };

    const deploymentKey = `${prNumber}-${pr.head.sha}`;
    if (seenRailwayDeployments.has(deploymentKey)) {
      return { ok: true, ignored: 'duplicate railway deployment' };
    }
    seenRailwayDeployments.add(deploymentKey);

    req.log.info(`PR #${prNumber} — Railway bot posted preview: ${targetUrl}`);
    return handlePreviewUrl({
      octokit,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      sha: pr.head.sha,
      targetUrl,
      source: 'Railway',
      log: req.log,
    });
  }

  if (event !== 'pull_request') {
    return { ok: true, ignored_event: event };
  }

  const { action } = payload;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const baseRef = payload.pull_request?.base?.ref;

  if (action !== 'opened' && action !== 'reopened' && action !== 'synchronize') {
    return { ok: true, ignored_action: action };
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return reply.code(400).send({ error: 'missing installation id' });
  }

  const prNumber = payload.pull_request.number;
  const headRef = payload.pull_request.head.ref;
  const sha = payload.pull_request.head.sha;

  if (action === 'synchronize') {
    // New commit: invalidate the stale preview URL and wait for the new deployment
    previewUrls.delete(prNumber);
    pendingPRs.set(prNumber, { owner, repo, installationId });
    req.log.info(`PR #${prNumber} — new commit on ${headRef}, awaiting new preview deployment...`);
    return { ok: true, awaiting_new_deployment: true };
  }

  // action === 'opened' or 'reopened'
  req.log.info(`PR #${prNumber} ${action} — ${owner}/${repo} (${headRef} → ${baseRef})`);
  const previewUrl = previewUrls.get(prNumber);

  if (!previewUrl) {
    const alreadyPending = pendingPRs.has(prNumber);
    pendingPRs.set(prNumber, { owner, repo, installationId });
    if (!alreadyPending) {
      const octokit = await githubApp.getInstallationOctokit(installationId);
      const { data: comment } = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner,
          repo,
          issue_number: prNumber,
          body: '⏳ Waiting for deployment preview...',
        }
      );
      waitingComments.set(prNumber, comment.id);
      req.log.info(`PR #${prNumber} — no preview yet, posted placeholder comment`);
    }
    return { ok: true, pending_deployment: true };
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
  const repoConfig = await loadRepoConfig(octokit, owner, repo, req.log, sha);
  await runAndPostReport({
    octokit,
    owner,
    repo,
    prNumber,
    sha,
    headRef,
    baseRef,
    previewUrl,
    log: req.log,
    repoConfig,
  });
  return { ok: true };
});

fastify
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => {
    const b = staticConfig.budgets ?? {};
    fastify.log.info(`PerfGuard ready on ${address}`);
    fastify.log.info(
      `Budgets (fail) — perf≥${b.performance ?? '—'} | LCP≤${b.lcp ?? '—'}s | TBT≤${b.tbt ?? '—'}ms | CLS≤${b.cls ?? '—'} | FCP≤${b.fcp ?? '—'}s`
    );
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
