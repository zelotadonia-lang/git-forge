// REST v3 API under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. JSON everywhere, X-GitHub-Request-Id on
// every reply, Bearer token from MAKEFUN_SHOP_TOKEN. No network, no filesystem.

import {
  ZERO_OID,
  isOid,
  hashObject,
  parseCommit,
  parseTree,
  resolveRepo,
  trialTimestampSec,
  type Repo,
  type Store,
} from './store.ts';

export interface RestOptions {
  /** Expected bearer token; null disables auth (local development only). */
  token: string | null;
}

export interface RestRequest {
  method: string;
  path: string; // pathname under /api/v3, e.g. '/repos/o/r/issues'
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  host: string; // for absolute pagination Link URLs
}

export interface RestResponse {
  status: number;
  body: string; // JSON text ('' for 204)
  headers: Record<string, string>;
}

let requestCounter = 0;

function json(status: number, value: unknown, extraHeaders: Record<string, string> = {}): RestResponse {
  requestCounter += 1;
  return {
    status,
    body: `${JSON.stringify(value)}\n`,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `req-${requestCounter}`,
      ...extraHeaders,
    },
  };
}

const empty204 = (): RestResponse => {
  requestCounter += 1;
  return { status: 204, body: '', headers: { 'x-github-request-id': `req-${requestCounter}` } };
};

const notFound = (message = 'Not Found'): RestResponse => json(404, { message });
const badRequest = (message: string): RestResponse => json(400, { message });
const unauthorized = (): RestResponse => json(401, { message: 'Requires authentication' });

function parseBody(req: RestRequest): { ok: true; value: Record<string, unknown> } | { ok: false; response: RestResponse } {
  if (req.body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: badRequest('request body must be a JSON object') };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: badRequest('malformed JSON body') };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? ((item as { name: string }).name as string) : ''))
    .filter((item) => item !== '');
}

function decodeBase64(value: string): Buffer | null {
  try {
    const cleaned = value.replace(/[\r\n\t ]/g, '');
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCount.get(line) ?? 0;
    if (remaining > 0) oldCount.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCount.values()) deletions += remaining;
  return { additions, deletions };
}

function isoNow(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(trialTimestampSec() * 1000).toISOString();
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.seq,
    name: repo.name,
    full_name: repo.owner === null ? repo.name : `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner ?? '', id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
  };
}

function pullJson(pr: Repo['pulls'][number]): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: pr.number,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    merged: pr.merged,
  };
  if (pr.merged) {
    base.merged_at = pr.mergedAt;
    base.merge_commit_sha = pr.mergeCommitSha;
  }
  return base;
}

/** Resolve a ref name or commit oid to a commit oid, or null. */
function resolveRefTarget(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  if (isOid(ref) && repo.getObject(ref) !== undefined) return ref;
  return null;
}

/** Build a new tree from the branch tip's flat file map plus one path change. */
function applyFileChange(repo: Repo, tip: string | undefined, path: string, content: Buffer | null): { treeOid: string; blobOid: string | null } {
  const files = new Map<string, string>();
  if (tip !== undefined) {
    const tipObj = repo.getObject(tip);
    if (tipObj !== undefined && tipObj.type === 'commit') {
      const flat = repo.flattenTree(parseCommit(tipObj.data).tree);
      for (const [filePath, entry] of flat) files.set(filePath, entry.oid);
    }
  }
  let blobOid: string | null = null;
  if (content !== null) {
    blobOid = repo.putObject('blob', content);
    files.set(path, blobOid);
  } else {
    files.delete(path);
  }
  return { treeOid: repo.writeTreeFromFiles(files), blobOid };
}

function diffFileLists(
  repo: Repo,
  baseTip: string,
  headTip: string,
): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }[] {
  const baseTree = ((): Map<string, { oid: string; mode: string }> => {
    const obj = repo.getObject(baseTip);
    return obj !== undefined && obj.type === 'commit' ? repo.flattenTree(parseCommit(obj.data).tree) : new Map();
  })();
  const headTree = ((): Map<string, { oid: string; mode: string }> => {
    const obj = repo.getObject(headTip);
    return obj !== undefined && obj.type === 'commit' ? repo.flattenTree(parseCommit(obj.data).tree) : new Map();
  })();
  const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number }[] = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseTree.get(path);
    const head = headTree.get(path);
    if (base !== undefined && head === undefined) {
      const oldText = repo.getObject(base.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions });
    } else if (base === undefined && head !== undefined) {
      const newText = repo.getObject(head.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', newText);
      out.push({ filename: path, status: 'added', additions, deletions: 0 });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldText = repo.getObject(base.oid)?.data.toString('utf8') ?? '';
      const newText = repo.getObject(head.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions });
    }
  }
  return out;
}

export function handleRest(store: Store, opts: RestOptions, req: RestRequest): RestResponse {
  const segments = req.path.split('/').filter((segment) => segment !== '');
  const method = req.method;

  // Root and meta need no token in the suite's calls, but the token rule is
  // "a request without it is 401" for repository resources; root/meta are
  // probed with the token. Enforce auth everywhere except /healthz (not here).
  const token = req.headers.authorization ?? '';
  const authed = opts.token === null || token === `Bearer ${opts.token}`;
  if (!authed) return unauthorized();

  // GET /api/v3/  (path '' after the prefix strip)
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }

  // POST /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos' && method === 'POST') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.response;
    const name = asString(parsed.value.name);
    if (name === '') return json(422, { message: 'name is required' });
    const repo = store.createRepo(name, asString(parsed.value.description), parsed.value.private === true);
    if (repo === null) return json(422, { message: 'Repository already exists' });
    return json(201, repoJson(repo));
  }

  // GET /user/repos (paginated)
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method !== 'GET') return notFound();
    const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(req.query.get('page') ?? '1', 10) || 1);
    const all = store.listRepos();
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      const next = `http://${req.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${next}>; rel="next"`;
    }
    return json(200, slice.map((repo) => repoJson(repo)), headers);
  }

  // /repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] as string);
    const name = decodeURIComponent(segments[2] as string);
    const repo = resolveRepo(store, owner, name);
    if (repo === null) return notFound('Not Found');
    const rest = segments.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(name);
        return empty204();
      }
      return notFound();
    }

    // POST /git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') return notFound();
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha).toLowerCase();
      if (!ref.startsWith('refs/heads/') || !isOid(sha) || repo.getObject(sha) === undefined) {
        return json(422, { message: 'Invalid ref or sha' });
      }
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha } });
    }

    // GET /branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return notFound();
      const branches = [...repo.refs.entries()]
        .filter(([refName]) => refName.startsWith('refs/heads/'))
        .map(([refName, sha]) => ({ name: refName.slice('refs/heads/'.length), commit: { sha } }));
      return json(200, branches);
    }

    // GET /commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return notFound();
      const target = resolveRefTarget(repo, req.query.get('sha') ?? undefined);
      if (target === null) return json(200, []);
      const history = repo.commitHistory(target);
      return json(200, history.map((entry) => ({ sha: entry.sha, commit: { message: entry.message } })));
    }

    // /contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'PUT') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const content = decodeBase64(asString(parsed.value.content));
        if (content === null) return badRequest('content must be base64');
        const branch = asString(parsed.value.branch) || repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip === undefined && repo.refs.size > 0) return notFound('Branch not found');
        let currentBlob: string | undefined;
        if (tip !== undefined) {
          const tipObj = repo.getObject(tip);
          if (tipObj !== undefined && tipObj.type === 'commit') {
            currentBlob = repo.flattenTree(parseCommit(tipObj.data).tree).get(filePath)?.oid;
          }
        }
        const isUpdate = currentBlob !== undefined;
        const givenSha = asString(parsed.value.sha).toLowerCase();
        if (isUpdate && givenSha !== '' && givenSha !== currentBlob) {
          return json(409, { message: 'sha does not match the current blob' });
        }
        const { treeOid, blobOid } = applyFileChange(repo, tip, filePath, content);
        const parents = tip === undefined ? [] : [tip];
        const commitSha = repo.createCommit(treeOid, parents, asString(parsed.value.message) || `Update ${filePath}`);
        repo.refs.set(branchRef, commitSha);
        return json(isUpdate ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      if (method === 'GET') {
        const target = resolveRefTarget(repo, req.query.get('ref') ?? undefined);
        if (target === null) return notFound('Not Found');
        const targetObj = repo.getObject(target);
        if (targetObj === undefined || targetObj.type !== 'commit') return notFound('Not Found');
        const treeOid = parseCommit(targetObj.data).tree;
        const found = repo.lookupPath(treeOid, filePath);
        if (found === null) return notFound('Not Found');
        if (found.kind === 'file') {
          const blob = repo.getObject(found.oid) as { data: Buffer };
          return json(200, {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: found.oid,
            size: found.size,
            name: filePath.split('/').pop(),
            path: filePath,
          });
        }
        return json(200, found.entries.map((entry) => ({ type: entry.kind, name: entry.name, path: entry.path, sha: entry.oid })));
      }
      if (method === 'DELETE') {
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        const branch = asString(parsed.value.branch) || repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip === undefined) return notFound('Not Found');
        const tipObj = repo.getObject(tip);
        if (tipObj === undefined || tipObj.type !== 'commit') return notFound('Not Found');
        const flat = repo.flattenTree(parseCommit(tipObj.data).tree);
        if (!flat.has(filePath)) return notFound('Not Found');
        const { treeOid } = applyFileChange(repo, tip, filePath, null);
        const commitSha = repo.createCommit(treeOid, [tip], asString(parsed.value.message) || `Delete ${filePath}`);
        repo.refs.set(branchRef, commitSha);
        return json(200, { commit: { sha: commitSha } });
      }
      return notFound();
    }

    // POST /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return notFound();
      const parsed = parseBody(req);
      if (!parsed.ok) return parsed.response;
      const labelName = asString(parsed.value.name);
      const color = asString(parsed.value.color) || 'ededed';
      if (labelName === '') return json(422, { message: 'name is required' });
      repo.labels.set(labelName, { name: labelName, color });
      return json(201, { name: labelName, color });
    }

    // /issues...
    if (rest.length >= 1 && rest[0] === 'issues') {
      // POST /issues, GET /issues
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const labels = asStringArray(parsed.value.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) return json(422, { message: `Label does not exist: ${label}` });
          }
          const issue = {
            number: repo.nextIssue,
            title: asString(parsed.value.title),
            body: asString(parsed.value.body),
            state: 'open' as const,
            labels,
            comments: [] as { id: number; body: string }[],
          };
          repo.nextIssue += 1;
          repo.issues.push(issue);
          return json(201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          const perPage = Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30);
          let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          }
          return json(200, list.slice(0, perPage).map((issue) => issueJson(repo, issue)));
        }
        return notFound();
      }
      // /issues/{n}[/comments]
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound();
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
          return json(200, issueJson(repo, issue));
        }
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const comment = { id: repo.nextCommentId, body: asString(parsed.value.body) };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return json(201, comment);
        }
        if (method === 'GET') return json(200, issue.comments);
        return notFound();
      }
      return notFound();
    }

    // /pulls...
    if (rest.length >= 1 && rest[0] === 'pulls') {
      // POST /pulls, GET /pulls
      if (rest.length === 1) {
        if (method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return parsed.response;
          const headRef = asString(parsed.value.head);
          const baseRef = asString(parsed.value.base);
          const headSha = repo.refs.get(`refs/heads/${headRef}`);
          const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
          if (headSha === undefined || baseSha === undefined) {
            return json(422, { message: 'head or base branch not found' });
          }
          const pr = {
            number: repo.nextPull,
            title: asString(parsed.value.title),
            body: asString(parsed.value.body),
            state: 'open' as const,
            headRef,
            baseRef,
            headSha,
            baseSha,
            merged: false,
            mergedAt: null as string | null,
            mergeCommitSha: null as string | null,
          };
          repo.nextPull += 1;
          repo.pulls.push(pr);
          return json(201, pullJson(pr));
        }
        if (method === 'GET') {
          const state = req.query.get('state') ?? undefined;
          const perPage = Math.max(1, Number.parseInt(req.query.get('per_page') ?? '30', 10) || 30);
          const list = repo.pulls.filter((pr) => state === 'all' || (state === undefined ? pr.state === 'open' : pr.state === state));
          return json(200, list.slice(0, perPage).map((pr) => pullJson(pr)));
        }
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isInteger(number)) return notFound();
      const pr = repo.pulls.find((candidate) => candidate.number === number);
      if (pr === undefined) return notFound('Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return json(200, pullJson(pr));
        return notFound();
      }
      // GET /pulls/{n}/files
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') return notFound();
        const files = diffFileLists(repo, pr.baseSha, pr.headSha).filter((file) => file.status !== 'removed');
        return json(200, files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
        })));
      }
      // PUT /pulls/{n}/merge
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') return notFound();
        const parsed = parseBody(req);
        if (!parsed.ok) return parsed.response;
        if (pr.state !== 'open' || pr.merged) return json(405, { message: 'Pull request is not open' });
        const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
        const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
        if (baseTip === undefined || headTip === undefined) return json(405, { message: 'Branch not found' });
        const baseChanged = diffFileLists(repo, pr.baseSha, baseTip);
        const headChanged = diffFileLists(repo, pr.baseSha, headTip);
        const baseChangedByPath = new Map(baseChanged.map((file) => [file.filename, file]));
        let conflict = false;
        for (const file of headChanged) {
          if (!baseChangedByPath.has(file.filename)) continue;
          // Same path changed on both sides since the PR branched off.
          const baseNow = repo.getObject(baseTip) !== undefined && repo.getObject(baseTip)?.type === 'commit'
            ? repo.flattenTree(parseCommit((repo.getObject(baseTip) as { data: Buffer }).data).tree).get(file.filename)?.oid
            : undefined;
          const headNow = repo.getObject(headTip) !== undefined && repo.getObject(headTip)?.type === 'commit'
            ? repo.flattenTree(parseCommit((repo.getObject(headTip) as { data: Buffer }).data).tree).get(file.filename)?.oid
            : undefined;
          if (baseNow !== headNow) conflict = true;
        }
        if (conflict) return json(405, { message: 'Merge conflict' });
        // Squash: base tree with the head's changes applied, one commit on base.
        const baseFlat = ((): Map<string, string> => {
          const baseObj = repo.getObject(baseTip);
          const out = new Map<string, string>();
          if (baseObj !== undefined && baseObj.type === 'commit') {
            for (const [path, entry] of repo.flattenTree(parseCommit(baseObj.data).tree)) out.set(path, entry.oid);
          }
          return out;
        })();
        const headFlat = ((): Map<string, string> => {
          const headObj = repo.getObject(headTip);
          const out = new Map<string, string>();
          if (headObj !== undefined && headObj.type === 'commit') {
            for (const [path, entry] of repo.flattenTree(parseCommit(headObj.data).tree)) out.set(path, entry.oid);
          }
          return out;
        })();
        for (const file of headChanged) {
          if (file.status === 'removed') baseFlat.delete(file.filename);
          else {
            const oid = headFlat.get(file.filename);
            if (oid !== undefined) baseFlat.set(file.filename, oid);
          }
        }
        const treeOid = repo.writeTreeFromFiles(baseFlat);
        const mergeSha = repo.createCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
        repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
        pr.state = 'closed';
        pr.merged = true;
        pr.mergedAt = isoNow();
        pr.mergeCommitSha = mergeSha;
        return json(200, { merged: true, sha: mergeSha, message: 'Pull request successfully merged' });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}
