import { createServer } from 'node:http';

// A stand-in for the GitHub REST API, scoped to one repository and one PR.
//
// It implements exactly the endpoints the GitHub forge adapter calls, with
// GitHub's own status codes, and records every write so the suite can assert on
// what would have landed on a real PR — without creating one.
//
// Two tokens model the permission boundary /v1/audit relies on:
//   writeToken — can read and write, like a job granted `pull-requests: write`
//   readToken  — can read but every write gets 403, like a read-only token
// Anything else is rejected with 401.
export async function startFakeGithub({ owner, repo, prNumber, writeToken, readToken }) {
  const state = {
    headSha: null,
    headRef: 'kanso-acceptance',
    baseRef: 'main',
    comments: [],
    edits: 0,
    statuses: [],
    unexpected: [],
  };
  let nextCommentId = 1000;

  const prefix = `/repos/${owner}/${repo}`;
  const routes = [
    ['GET', new RegExp(`^${prefix}/pulls/${prNumber}$`), () => [200, {
      number: prNumber,
      state: 'open',
      head: { sha: state.headSha, ref: state.headRef },
      base: { ref: state.baseRef },
    }]],
    ['GET', new RegExp(`^${prefix}/issues/${prNumber}/comments$`), (_, query) =>
      [200, Number(query.get('page') ?? 1) === 1 ? state.comments : []]],
    ['POST', new RegExp(`^${prefix}/issues/${prNumber}/comments$`), (_, __, body) => {
      const comment = { id: nextCommentId++, body: body.body };
      state.comments.push(comment);
      return [201, comment];
    }],
    ['PATCH', new RegExp(`^${prefix}/issues/comments/(\\d+)$`), (match, __, body) => {
      const comment = state.comments.find((c) => c.id === Number(match[1]));
      if (!comment) return [404, { message: 'Not Found' }];
      comment.body = body.body;
      state.edits++;
      return [200, comment];
    }],
    ['POST', new RegExp(`^${prefix}/statuses/([0-9a-f]{40})$`), (match, __, body) => {
      state.statuses.push({ sha: match[1], state: body.state, description: body.description, context: body.context });
      return [201, {}];
    }],
    ['GET', new RegExp(`^${prefix}/pulls/${prNumber}/files$`), () => [200, []]],
    ['GET', new RegExp(`^${prefix}/contents/`), () => [404, { message: 'Not Found' }]],
  ];

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      };

      // Octokit sends "token <t>"; accept "Bearer <t>" as GitHub does.
      const token = (req.headers.authorization ?? '').split(/\s+/).pop();
      if (token !== writeToken && token !== readToken) return send(401, { message: 'Bad credentials' });
      if (req.method !== 'GET' && token !== writeToken) {
        return send(403, { message: 'Resource not accessible by personal access token' });
      }

      const url = new URL(req.url, 'http://github.test');
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && url.pathname.match(pattern);
        if (!match) continue;
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          return send(400, { message: 'Problems parsing JSON' });
        }
        return send(...handler(match, url.searchParams, body));
      }

      // Recorded rather than thrown: the forge may legitimately grow a call, and
      // the suite reports it instead of hanging on a dropped connection.
      state.unexpected.push(`${req.method} ${url.pathname}`);
      return send(404, { message: 'Not Found' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    // Simulates a push: the PR head moves to a new commit.
    push(sha) {
      state.headSha = sha;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
