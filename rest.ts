// GitHub REST v3 surface, per kit program/env/src/checks-rest.ts.
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors carry
// {"message": ...}. Auth is the single bearer token MAKEFUN_SHOP_TOKEN:
// missing/wrong token is 401, a repo under another owner is 404 (never 403).

import {
  VIEWER,
  buildTree,
  collectReachable,
  globalId,
  hashObject,
  mergeBase,
  nowEpochSec,
  nowIso,
  parseCommit,
  parseTree,
  putObject,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** decoded path segments, e.g. ['api','v3','repos',owner,name,'issues'] */
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** raw request body (may be empty) */
  body: Buffer;
  /** origin for absolute pagination links, e.g. http://127.0.0.1:1234 */
  origin: string;
}

export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  /** body bytes; null means no body (204) */
  body: Buffer | null;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, headers, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

function err(status: number, message: string): RestResult {
  return json(status, { message });
}

function noBody(status: number): RestResult {
  return { status, body: null };
}

function parseBody(req: RestRequest): unknown {
  if (req.body.length === 0) return {};
  try {
    return JSON.parse(req.body.toString('utf8'));
  } catch {
    return null; // sentinel: malformed JSON
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function tokenOk(req: RestRequest): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const got = req.headers['authorization'] ?? '';
  if (!expected) return got.startsWith('Bearer ') && got.length > 7;
  return got === `Bearer ${expected}`;
}

// -------------------------------------------------------------------------------- shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pr.number,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged ? pr.updatedAt : null,
    merge_commit_sha: pr.mergeSha,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}`, user: { login: VIEWER.login } },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}`, user: { login: VIEWER.login } },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

/** File maps of two commits, for diffs. */
function filesAt(repo: Repo, tip: string | undefined): Map<string, string> {
  if (!tip) return new Map();
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return new Map();
  const files = new Map<string, string>();
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else files.set(path, e.oid);
    }
  };
  walk(parseCommit(obj.data).tree, '');
  return files;
}

/** Changed paths between base and head file maps, with line counts. */
function diffFiles(
  repo: Repo,
  baseFiles: Map<string, string>,
  headFiles: Map<string, string>,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b === h) continue;
    const bObj = b ? repo.objects.get(b) : undefined;
    const hObj = h ? repo.objects.get(h) : undefined;
    const bLines = bObj ? bObj.data.toString('utf8').split('\n').length : 0;
    const hLines = hObj ? hObj.data.toString('utf8').split('\n').length : 0;
    let additions = 0;
    let deletions = 0;
    if (!bObj) {
      additions = Math.max(1, hLines);
    } else if (!hObj) {
      deletions = Math.max(1, bLines);
    } else {
      // simple line multiset diff
      const bSet = new Map<string, number>();
      for (const l of bObj.data.toString('utf8').split('\n')) bSet.set(l, (bSet.get(l) ?? 0) + 1);
      let common = 0;
      for (const l of hObj.data.toString('utf8').split('\n')) {
        const c = bSet.get(l) ?? 0;
        if (c > 0) {
          bSet.set(l, c - 1);
          common += 1;
        }
      }
      additions = Math.max(1, hLines - common);
      deletions = Math.max(0, bLines - common);
    }
    out.push({
      filename: path,
      status: !b ? 'added' : !h ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

/** Conflict test for a squash merge: same file changed on both sides of the merge-base. */
function mergeConflicts(repo: Repo, pr: PullRequest): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  if (!baseTip || !headTip) return false;
  if (baseTip === headTip) return false;
  const base = mergeBase(baseTip, headTip, (oid) => repo.objects.get(oid));
  if (!base) {
    // No common history: conflict unless the trees are identical.
    const bf = filesAt(repo, baseTip);
    const hf = filesAt(repo, headTip);
    if (bf.size !== hf.size) return true;
    for (const [p, oid] of bf) if (hf.get(p) !== oid) return true;
    return false;
  }
  const baseFiles = filesAt(repo, base);
  const baseTipFiles = filesAt(repo, baseTip);
  const headTipFiles = filesAt(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headTipFiles.keys()]);
  for (const p of paths) {
    const m = baseFiles.get(p);
    const b = baseTipFiles.get(p);
    const h = headTipFiles.get(p);
    if (b !== m && h !== m && b !== h) return true;
  }
  return false;
}

// -------------------------------------------------------------------------------- router

export function handleRest(store: Store, req: RestRequest): RestResult | null {
  const seg = req.segments;
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return null;

  if (!tokenOk(req)) return err(401, 'Requires authentication');

  const rest = seg.slice(2); // after /api/v3
  const bodyParsed = parseBody(req);
  if (bodyParsed === null) return err(400, 'Problems parsing JSON');
  const body = asObject(bodyParsed);

  // GET /api/v3/ (root)
  if (rest.length === 0 && req.method === 'GET') {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta' && req.method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }
  // GET /api/v3/user (viewer; used by the MCP client as the owner source)
  if (rest.length === 1 && rest[0] === 'user' && req.method === 'GET') {
    return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // POST /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'POST') {
      const name = asString(body.name);
      if (!name) return err(422, 'name is required');
      if (store.getRepo(VIEWER.login, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER.login, name, asString(body.description), body.private === true);
      return json(201, repoJson(repo));
    }
    if (req.method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
      const all = store.listRepos(VIEWER.login);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const next = `${req.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers['link'] = `<${next}>; rel="next"`;
      }
      return json(200, slice.map(repoJson), headers);
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    // A repo under another owner is 404, never 403.
    if (owner !== VIEWER.login) return err(404, 'Not Found');
    const repo = store.getRepo(owner, name);
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (req.method === 'GET') {
        if (!repo) return err(404, 'Not Found');
        return json(200, repoJson(repo));
      }
      if (req.method === 'PATCH') {
        if (!repo) return err(404, 'Not Found');
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updatedAt = nowIso();
        return json(200, repoJson(repo));
      }
      if (req.method === 'DELETE') {
        if (!repo) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return noBody(204);
      }
      return err(404, 'Not Found');
    }
    if (!repo) return err(404, 'Not Found');

    // POST /git/refs
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs' && req.method === 'POST') {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'Invalid ref or sha');
      if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha.toLowerCase());
      store.refreshBranchFiles(repo, ref);
      return json(201, { ref, object: { sha: sha.toLowerCase() } });
    }
    // GET /branches
    if (tail.length === 1 && tail[0] === 'branches' && req.method === 'GET') {
      const branches: Array<Record<string, unknown>> = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      return json(200, branches);
    }
    // GET /commits
    if (tail.length === 1 && tail[0] === 'commits' && req.method === 'GET') {
      const refParam = req.query.get('sha');
      const ref = refParam ? (refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`) : `refs/heads/${repo.defaultBranch}`;
      const tip = repo.refs.get(ref);
      const commits: Array<Record<string, unknown>> = [];
      if (tip) {
        // Newest first: BFS by generation from the tip.
        const seen = new Set<string>();
        const queue: string[] = [tip];
        const ordered: string[] = [];
        while (queue.length) {
          const oid = queue.shift()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          ordered.push(oid);
          for (const p of parseCommit(obj.data).parents) queue.push(p);
        }
        for (const oid of ordered) {
          const c = parseCommit(repo.objects.get(oid)!.data);
          commits.push({
            sha: oid,
            commit: { message: c.message, author: { name: c.author }, committer: { name: c.committer } },
            parents: c.parents.map((p) => ({ sha: p })),
          });
        }
      }
      return json(200, commits);
    }
    // /contents/{path...}
    if (tail.length >= 1 && tail[0] === 'contents') {
      return handleContents(store, repo, tail.slice(1), req, body);
    }
    // POST /labels
    if (tail.length === 1 && tail[0] === 'labels' && req.method === 'POST') {
      const labelName = asString(body.name);
      if (!labelName) return err(422, 'name is required');
      const color = asString(body.color, 'ededed');
      repo.labels.set(labelName, { name: labelName, color, description: asString(body.description) });
      return json(201, { name: labelName, color, description: asString(body.description) });
    }
    // /issues...
    if (tail.length >= 1 && tail[0] === 'issues') {
      return handleIssues(store, repo, tail.slice(1), req, body);
    }
    // /pulls...
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return handlePulls(store, repo, tail.slice(1), req, body);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- contents

function resolveRefTip(repo: Repo, refParam: string | null): { tip: string | undefined; ref: string } {
  if (!refParam) return { tip: repo.refs.get(`refs/heads/${repo.defaultBranch}`), ref: `refs/heads/${repo.defaultBranch}` };
  if (/^[0-9a-f]{40}$/i.test(refParam)) return { tip: refParam.toLowerCase(), ref: refParam.toLowerCase() };
  const ref = refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`;
  return { tip: repo.refs.get(ref), ref };
}

function handleContents(store: Store, repo: Repo, pathSegs: string[], req: RestRequest, body: Record<string, unknown>): RestResult {
  const path = pathSegs.join('/');
  const branchParam = typeof body.branch === 'string' ? body.branch : undefined;
  const refParam = req.query.get('ref');

  if (req.method === 'PUT') {
    const contentB64 = asString(body.content);
    if (!contentB64) return err(422, 'content is required');
    let bytes: Buffer;
    try {
      bytes = Buffer.from(contentB64, 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const branch = branchParam ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    if (!repo.refs.has(ref) && repo.refs.size > 0 && branch !== repo.defaultBranch) {
      // Creating a commit on a branch that does not exist yet: only the
      // default branch may be born this way.
      return err(404, 'Not Found');
    }
    const blobOid = hashObject('blob', bytes);
    putObject(repo.objects, 'blob', bytes);
    const files = new Map(repo.branchFiles.get(ref) ?? new Map());
    const existing = files.get(path);
    const isUpdate = existing !== undefined;
    if (isUpdate && typeof body.sha === 'string' && body.sha.toLowerCase() !== existing) {
      return err(409, 'sha does not match the current blob');
    }
    files.set(path, blobOid);
    const message = asString(body.message, isUpdate ? `Update ${path}` : `Create ${path}`);
    const commitSha = store.commitOnBranch(repo, ref, files, message, VIEWER);
    return json(isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitSha, message },
    });
  }

  if (req.method === 'DELETE') {
    const branch = branchParam ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const files = new Map(repo.branchFiles.get(ref) ?? new Map());
    const existing = files.get(path);
    if (!existing) return err(404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha.toLowerCase() !== existing) {
      return err(409, 'sha does not match the current blob');
    }
    files.delete(path);
    const message = asString(body.message, `Delete ${path}`);
    const commitSha = store.commitOnBranch(repo, ref, files, message, VIEWER);
    return json(200, { commit: { sha: commitSha, message } });
  }

  if (req.method === 'GET') {
    const { tip } = resolveRefTip(repo, refParam);
    if (!tip) return err(404, 'Not Found');
    const files = filesAt(repo, tip);
    const exact = files.get(path);
    if (exact !== undefined) {
      const obj = repo.objects.get(exact)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: obj.data.toString('base64'),
        sha: exact,
        size: obj.data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    // Directory listing: immediate children under path + '/'.
    const prefix = path ? `${path}/` : '';
    const children = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [p, oid] of files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        if (!children.has(first)) {
          // tree oid of that sub-directory
          const sub = new Map<string, string>();
          for (const [pp, oo] of files) {
            if (pp.startsWith(`${prefix}${first}/`)) sub.set(pp.slice(`${prefix}${first}/`.length), oo);
          }
          const treeOid = store.buildTreeFromFiles(repo, sub);
          children.set(first, { type: 'dir', name: first, path: `${prefix}${first}`, sha: treeOid });
        }
      } else {
        children.set(first, { type: 'file', name: first, path: p, sha: oid });
      }
    }
    if (children.size === 0) return err(404, 'Not Found');
    return json(200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, tail: string[], req: RestRequest, body: Record<string, unknown>): RestResult {
  // POST /issues/{n}/comments and GET /issues/{n}/comments
  // (tail here excludes the leading 'issues' segment)
  if (tail.length === 2 && tail[1] === 'comments') {
    const n = Number.parseInt(tail[0]!, 10);
    const issue = repo.issues.get(n);
    if (!issue) return err(404, 'Not Found');
    if (req.method === 'POST') {
      const text = asString(body.body);
      if (!text) return err(422, 'body is required');
      repo.commentSeq += 1;
      const comment = {
        id: repo.commentSeq,
        node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${repo.commentSeq}`),
        body: text,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      issue.comments.push({ id: String(repo.commentSeq), body: text, createdSeq: repo.commentSeq, createdAt: comment.created_at });
      issue.updatedAt = nowIso();
      return json(201, comment);
    }
    if (req.method === 'GET') {
      return json(200, issue.comments.map((c) => ({ id: Number.parseInt(c.id, 10), node_id: globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${c.id}`), body: c.body, created_at: c.createdAt })));
    }
    return err(404, 'Not Found');
  }
  // GET /issues (list)
  if (tail.length === 0 && req.method === 'GET') {
    const state = req.query.get('state') ?? 'open';
    const sort = req.query.get('sort') ?? 'created';
    const direction = req.query.get('direction') ?? 'desc';
    const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((i) => i.state === 'open');
    else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
    if (sort === 'created') {
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    }
    return json(200, list.slice(0, perPage).map((i) => issueJson(repo, i)));
  }
  // POST /issues (create)
  if (tail.length === 0 && req.method === 'POST') {
    const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => String(l)) : [];
    for (const l of labels) {
      if (!repo.labels.has(l)) return err(422, `Label does not exist: ${l}`);
    }
    const issue = createIssueRecord(repo, asString(body.title), asString(body.body), labels);
    return json(201, issueJson(repo, issue));
  }
  // GET / PATCH /issues/{n}
  if (tail.length === 1) {
    const n = Number.parseInt(tail[0]!, 10);
    const issue = repo.issues.get(n);
    if (!issue) return err(404, 'Not Found');
    if (req.method === 'GET') return json(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      issue.updatedAt = nowIso();
      return json(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------- shared record helpers (also used by GraphQL/MCP)

let issueSeqCounter = 0;
function nextSeqGlobal(): number {
  issueSeqCounter += 1;
  return issueSeqCounter;
}

export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.issueSeq += 1;
  const now = nowIso();
  const issue: Issue = {
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    createdSeq: nextSeqGlobal(),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(repo: Repo, head: string, base: string, title: string, body: string): PullRequest | null {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return null;
  repo.prSeq += 1;
  const now = nowIso();
  const files = diffFiles(repo, filesAt(repo, baseTip), filesAt(repo, headTip)).map((f) => f.filename);
  const pr: PullRequest = {
    number: repo.prSeq,
    title,
    body,
    state: 'open',
    merged: false,
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    mergeSha: null,
    files,
    createdSeq: nextSeqGlobal(),
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pr.number, pr);
  return pr;
}

/** Squash-merge a PR. Returns HTTP-style status + merge sha on success. */
export function mergePullRecord(store: Store, repo: Repo, pr: PullRequest): { status: number; sha?: string; message: string } {
  if (pr.state !== 'open' || pr.merged) return { status: 405, message: 'Pull request is not open' };
  if (mergeConflicts(repo, pr)) return { status: 405, message: 'Merge conflict' };
  const baseRef = `refs/heads/${pr.base}`;
  const headRef = `refs/heads/${pr.head}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return { status: 422, message: 'head or base branch does not exist' };
  const baseFiles = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, headTip);
  const mergeBaseOid = mergeBase(baseTip, headTip, (oid) => repo.objects.get(oid));
  const mergeBaseFiles = mergeBaseOid ? filesAt(repo, mergeBaseOid) : new Map<string, string>();
  const merged = new Map(baseFiles);
  const paths = new Set([...mergeBaseFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const m = mergeBaseFiles.get(p);
    const h = headFiles.get(p);
    if (h !== m) {
      if (h === undefined) merged.delete(p);
      else merged.set(p, h);
    }
  }
  const message = `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`;
  const commitSha = store.commitOnBranch(repo, baseRef, merged, message, VIEWER);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeSha = commitSha;
  pr.updatedAt = nowIso();
  return { status: 200, sha: commitSha, message: `Pull request #${pr.number} merged` };
}


// -------------------------------------------------------------------------------- pulls

function handlePulls(store: Store, repo: Repo, tail: string[], req: RestRequest, body: Record<string, unknown>): RestResult {
  // GET /pulls (list)
  if (tail.length === 0 && req.method === 'GET') {
    const state = req.query.get('state');
    const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    let list = [...repo.pulls.values()];
    if (state === 'all') {
      // all states
    } else if (state === 'closed') {
      list = list.filter((p) => p.state === 'closed');
    } else {
      list = list.filter((p) => p.state === 'open');
    }
    return json(200, list.slice(0, perPage).map((p) => pullJson(repo, p)));
  }
  // POST /pulls (create)
  if (tail.length === 0 && req.method === 'POST') {
    const head = asString(body.head);
    const base = asString(body.base);
    const pr = createPullRecord(repo, head, base, asString(body.title), asString(body.body));
    if (!pr) return err(422, 'head or base branch does not exist');
    return json(201, pullJson(repo, pr));
  }
  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files' && req.method === 'GET') {
    const n = Number.parseInt(tail[0]!, 10);
    const pr = repo.pulls.get(n);
    if (!pr) return err(404, 'Not Found');
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    const files = diffFiles(repo, filesAt(repo, baseTip), filesAt(repo, headTip));
    return json(200, files);
  }
  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge' && req.method === 'PUT') {
    const n = Number.parseInt(tail[0]!, 10);
    const pr = repo.pulls.get(n);
    if (!pr) return err(404, 'Not Found');
    const result = mergePullRecord(store, repo, pr);
    if (result.status !== 200) return err(result.status, result.message);
    return json(200, { merged: true, sha: result.sha, message: result.message });
  }
  // GET /pulls/{n}
  if (tail.length === 1 && req.method === 'GET') {
    const n = Number.parseInt(tail[0]!, 10);
    const pr = repo.pulls.get(n);
    if (!pr) return err(404, 'Not Found');
    return json(200, pullJson(repo, pr));
  }
  return err(404, 'Not Found');
}

// Re-exported for graphql.ts/mcp.ts parity helpers.
export { filesAt, diffFiles, mergeConflicts };
export type { RestRequest as RestReq };
export { buildTree, putObject, hashObject, nowEpochSec };
