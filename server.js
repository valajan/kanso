import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
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

const config = yaml.load(readFileSync('./config.yml', 'utf8'));

if (!config.base_url) throw new Error('Missing config: base_url');
if (!config.score_reference_file) throw new Error('Missing config: score_reference_file');

const MAIN_REF_URL = config.base_url;
const MAIN_REF_FILE = config.score_reference_file;
const DEPLOY_WAIT_MS = (config.deploy_wait_seconds ?? 120) * 1000;
const PREVIEW_WAIT_MS = (config.preview_wait_seconds ?? 15) * 1000;
const BUDGET = config.budgets ?? {};

const privateKey = readFileSync(PRIVATE_KEY_PATH, 'utf8');

const githubApp = new App({ appId: APP_ID, privateKey });

function loadMainRefScore() {
  try {
    return JSON.parse(readFileSync(MAIN_REF_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function persistMainRefScore(score) {
  writeFileSync(MAIN_REF_FILE, JSON.stringify(score, null, 2));
  mainRefScore = score;
}

let mainRefScore = loadMainRefScore();
const previewUrls = new Map();
const pendingPRs = new Map();
const waitingComments = new Map();

const fastify = Fastify({ logger: true });

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

// 'fail'  = PR violates the budget threshold → block merge
// 'warn'  = PR is within budget but worse than prod ref → warning
// 'pass'  = PR is at least as good as prod ref (or no ref available)
function buildStatus(prVal, refVal, budgetVal, lowerIsBetter) {
  if (budgetVal != null) {
    const failsBudget = lowerIsBetter ? prVal > budgetVal : prVal < budgetVal;
    if (failsBudget) return 'fail';
  }
  if (refVal != null) {
    const worseThanRef = lowerIsBetter ? prVal > refVal : prVal < refVal;
    if (worseThanRef) return 'warn';
  }
  return 'pass';
}

const STATUS_ICON = { pass: '✅', warn: '⚠️', fail: '❌' };

function formatDelta(delta, { unit = '', decimals = 0 } = {}) {
  return (delta >= 0 ? '+' : '') + delta.toFixed(decimals) + unit;
}

function detectSource(context) {
  const ctx = (context ?? '').toLowerCase();
  if (ctx.includes('vercel')) return 'Vercel Preview';
  if (ctx.includes('netlify')) return 'Netlify Preview';
  return 'Preview';
}

function formatComment(prScore, refScore, { previewUrl, headRef, baseRef = 'main', source = 'Preview', budget = {} } = {}) {
  const refPerf = refScore?.performance ?? null;
  const refLcp = refScore?.lcp ?? null;
  const refTbt = refScore != null ? Math.round(refScore.tbt) : null;
  const refCls = refScore?.cls ?? null;
  const refFcp = refScore?.fcp ?? null;
  const prTbt = Math.round(prScore.tbt);

  const headerLine = headRef
    ? `\`${headRef}\` → \`${baseRef}\` · ${source} detected automatically`
    : `🔗 URL: ${previewUrl}`;

  const note = refScore == null && Object.keys(budget).length === 0
    ? '\n_No reference score for main yet — diff will appear once a PR is merged to main._\n'
    : '';

  const fmtRef = (val, decimals, unit) => val == null ? '—' : val.toFixed(decimals) + unit;

  const statuses = {
    performance: buildStatus(prScore.performance, refPerf, budget.performance ?? null, false),
    lcp: buildStatus(prScore.lcp, refLcp, budget.lcp ?? null, true),
    tbt: buildStatus(prTbt, refTbt, budget.tbt ?? null, true),
    cls: buildStatus(prScore.cls, refCls, budget.cls ?? null, true),
    fcp: buildStatus(prScore.fcp, refFcp, budget.fcp ?? null, true),
  };

  const deltas = refScore != null ? {
    performance: formatDelta(prScore.performance - refPerf, { decimals: 0 }),
    lcp: formatDelta(prScore.lcp - refLcp, { unit: 's', decimals: 1 }),
    tbt: formatDelta(prTbt - refTbt, { unit: 'ms', decimals: 0 }),
    cls: formatDelta(prScore.cls - refCls, { decimals: 2 }),
    fcp: formatDelta(prScore.fcp - refFcp, { unit: 's', decimals: 1 }),
  } : null;

  const deltaCell = (key) => deltas?.[key] ?? '—';
  const iconCell = (key) => STATUS_ICON[statuses[key]];

  const table = [
    '| Metric | main | PR | Δ | |',
    '|---|---|---|---|---|',
    `| Performance | ${fmtRef(refPerf, 0, '')} | ${prScore.performance} | ${deltaCell('performance')} | ${iconCell('performance')} |`,
    `| LCP | ${fmtRef(refLcp, 1, 's')} | ${prScore.lcp.toFixed(1)}s | ${deltaCell('lcp')} | ${iconCell('lcp')} |`,
    `| TBT | ${fmtRef(refTbt, 0, 'ms')} | ${prTbt}ms | ${deltaCell('tbt')} | ${iconCell('tbt')} |`,
    `| CLS | ${fmtRef(refCls, 2, '')} | ${prScore.cls.toFixed(2)} | ${deltaCell('cls')} | ${iconCell('cls')} |`,
    `| FCP | ${fmtRef(refFcp, 1, 's')} | ${prScore.fcp.toFixed(1)}s | ${deltaCell('fcp')} | ${iconCell('fcp')} |`,
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
    log.info({ pr: pr.number, eventSha: sha, headSha: pr.head.sha }, 'ignoring stale deployment event');
    return { ok: true, ignored: 'sha is not PR head' };
  }

  const prNumber = pr.number;
  previewUrls.set(prNumber, targetUrl);

  if (pendingPRs.has(prNumber)) {
    pendingPRs.delete(prNumber);
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_WAIT_MS));
    await runAndPostReport({
      octokit, owner, repo, prNumber, sha,
      headRef: pr.head.ref, baseRef: pr.base.ref,
      previewUrl: targetUrl, source, log,
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

async function runAndPostReport({ octokit, owner, repo, prNumber, sha, headRef, baseRef, previewUrl, source, log }) {
  let prScore;
  try {
    prScore = await runLighthouse(previewUrl);
  } catch (err) {
    log.error({ err, previewUrl }, 'lighthouse failed on PR');
    await postOrEditComment({
      octokit, owner, repo, prNumber,
      body: `⚠️ PerfGuard — Lighthouse analysis failed: \`${err.message}\``,
    });
    return { ok: false, error: err.message };
  }

  const statuses = {
    performance: buildStatus(prScore.performance, mainRefScore?.performance ?? null, BUDGET.performance ?? null, false),
    lcp: buildStatus(prScore.lcp, mainRefScore?.lcp ?? null, BUDGET.lcp ?? null, true),
    tbt: buildStatus(Math.round(prScore.tbt), mainRefScore != null ? Math.round(mainRefScore.tbt) : null, BUDGET.tbt ?? null, true),
    cls: buildStatus(prScore.cls, mainRefScore?.cls ?? null, BUDGET.cls ?? null, true),
    fcp: buildStatus(prScore.fcp, mainRefScore?.fcp ?? null, BUDGET.fcp ?? null, true),
  };

  const baseBody = formatComment(prScore, mainRefScore, {
    previewUrl,
    headRef,
    baseRef,
    source,
    budget: BUDGET,
  });

  const regressions = detectSignificantRegressions({
    statuses, prScore, refScore: mainRefScore, budget: BUDGET,
  });

  const initialBody = regressions.length > 0
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
    }).catch((err) => log.warn({ err }, 'failed to post commit status'));
  }

  if (regressions.length > 0) {
    analyzePerformanceRegression({
      octokit, owner, repo, prNumber, regressions, log,
    })
      .then(async (aiSection) => {
        if (!aiSection) return;
        const updatedBody = replaceAnalysisSection(initialBody, aiSection);
        await octokit.request(
          'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          { owner, repo, comment_id: commentId, body: updatedBody }
        );
        log.info({ pr: prNumber, commentId }, '[ai-analysis] comment patched with analysis');
      })
      .catch((err) => log.warn({ err }, '[ai-analysis] background patch failed'));
  }

  log.info({ pr: prNumber, prScore, previewUrl }, 'perf report posted');
  return { ok: true, prScore };
}

fastify.get('/health', async () => ({ status: 'ok' }));

fastify.post('/webhook', async (req, reply) => {
  const signature = req.headers['x-hub-signature-256'];
  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];

  if (!verifySignature(req.rawBody, signature)) {
    req.log.warn({ delivery, event }, 'invalid signature');
    return reply.code(401).send({ error: 'invalid signature' });
  }

  const payload = req.body;

  if (event === 'ping') {
    return { ok: true, pong: true };
  }

  if (event === 'status' || event === 'deployment_status') {
    const isStatus = event === 'status';
    const state = isStatus ? payload.state : payload.deployment_status?.state;
    const targetUrl = isStatus ? payload.target_url : payload.deployment_status?.target_url;
    const sha = isStatus ? payload.sha : payload.deployment?.sha;
    const context = isStatus ? (payload.context ?? '') : (payload.deployment?.environment ?? '');

    if (isStatus && !context.toLowerCase().includes('netlify')) {
      return { ok: true, ignored: 'status not from netlify' };
    }
    if (state !== 'success' || !targetUrl || !sha) {
      return { ok: true, ignored_state: state };
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
      source: detectSource(context),
      log: req.log,
    });
  }

  if (event !== 'pull_request') {
    return { ok: true, ignored_event: event };
  }

  const { action } = payload;
  const baseRef = payload.pull_request?.base?.ref;
  const merged = payload.pull_request?.merged === true;

  if (action === 'closed' && merged && baseRef === 'main') {
    req.log.info({ delaySeconds: config.deploy_wait_seconds }, 'PR merged to main, scheduling main ref update');
    setTimeout(async () => {
      fastify.log.info({ url: MAIN_REF_URL }, 'running Lighthouse on production');
      try {
        const newScore = await runLighthouse(MAIN_REF_URL);
        persistMainRefScore(newScore);
        fastify.log.info({ score: mainRefScore }, 'main reference updated');
      } catch (err) {
        fastify.log.error({ err }, 'lighthouse failed on main ref update');
      }
    }, DEPLOY_WAIT_MS);
    return { ok: true, scheduled_ref_update: true };
  }

  if (action !== 'opened' && action !== 'synchronize') {
    return { ok: true, ignored_action: action };
  }

  const installationId = payload.installation?.id;
  if (!installationId) {
    return reply.code(400).send({ error: 'missing installation id' });
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const headRef = payload.pull_request.head.ref;
  const sha = payload.pull_request.head.sha;

  if (action === 'synchronize') {
    // New commit: invalidate the stale preview URL and wait for the new deployment
    previewUrls.delete(prNumber);
    pendingPRs.set(prNumber, { owner, repo, installationId });
    return { ok: true, awaiting_new_deployment: true };
  }

  // action === 'opened'
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
    }
    return { ok: true, pending_netlify: true };
  }

  const octokit = await githubApp.getInstallationOctokit(installationId);
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
  });
  return { ok: true };
});

fastify
  .listen({ port: PORT, host: '0.0.0.0' })
  .then((address) => {
    fastify.log.info(
      { mainRefScore, file: MAIN_REF_FILE, deployWaitSeconds: config.deploy_wait_seconds, budget: BUDGET },
      `PerfGuard listening on ${address}`
    );
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });
