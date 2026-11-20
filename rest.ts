// rest.ts — GitHub REST v3 under /api/v3. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (added by app.ts); errors carry {message}.
// A repository belongs to the login the token names: the same name under any
// other owner is 404, never 403.
import { hashObject, isOid, parseCommit, viewerLogin, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';

export interface RestResult { status: number; body: unknown; headers?: Record<string, string> }
const notFound = (msg = 'Not Found'): RestResult => ({ status: 404, body: { message: msg } });
const bad = (msg: string, status = 400): RestResult => ({ status, body: { message: msg } });

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id, name: repo.name, full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate, description: repo.description,
    default_branch: repo.defaultBranch, has_issues: true, has_projects: true,
    html_url: `https://example.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z',
  };
}
function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 100000 + issue.number, number: issue.number, title: issue.title,
    body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: repo.owner, id: 1000 }, comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}
function pullJson(repo: Repo, pr: PullRec): Record<string, unknown> {
  return {
    id: repo.id * 100000 + pr.number, number: pr.number, title: pr.title, body: pr.body,
    state: pr.state, merged: pr.merged, merged_at: pr.mergedAt, merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha, label: `${repo.owner}:${pr.headRef}` },
    base: { ref: pr.baseRef, sha: pr.baseSha, label: `${repo.owner}:${pr.baseRef}` },
    user: { login: repo.owner, id: 1000 },
    html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
  };
}
function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
export interface FileChange { filename: string; status: string; additions: number; deletions: number; changes: number }
export function diffFiles(repo: Repo, baseOid: string | undefined, headOid: string | undefined): FileChange[] {
  const base = baseOid ? repo.fileMap(baseOid) : new Map<string, string>();
  const head = headOid ? repo.fileMap(headOid) : new Map<string, string>();
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const content = repo.objects.get(h as string)?.data.toString('utf8') ?? '';
      const additions = countLines(content);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (h === undefined) {
      const content = repo.objects.get(b)?.data.toString('utf8') ?? '';
      const deletions = countLines(content);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const oldText = repo.objects.get(b)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h)?.data.toString('utf8') ?? '';
      const oldLines = new Set(oldText.split('\n'));
      const newLines = new Set(newText.split('\n'));
      let additions = 0;
      let deletions = 0;
      for (const l of newText.split('\n')) if (!oldLines.has(l)) additions += 1;
      for (const l of oldText.split('\n')) if (!newLines.has(l)) deletions += 1;
      if (additions === 0 && deletions === 0) additions = 1;
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}
function commonAncestor(repo: Repo, a: string | undefined, b: string | undefined): string | null {
  if (!a || !b) return null;
  const seen = new Set<string>();
  const stack = [repo.peelToCommit(a)];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  const stack2 = [repo.peelToCommit(b)];
  const seen2 = new Set<string>();
  while (stack2.length > 0) {
    const cur = stack2.pop() as string;
    if (seen.has(cur)) return cur;
    if (seen2.has(cur)) continue;
    seen2.add(cur);
    const obj = repo.objects.get(cur);
    if (obj && obj.type === 'commit') for (const p of parseCommit(obj.data).parents) stack2.push(p);
  }
  return null;
}
export function mergeConflicts(repo: Repo, pr: PullRec): boolean {
  const baseTip = repo.tip(`refs/heads/${pr.baseRef}`);
  const headTip = repo.tip(`refs/heads/${pr.headRef}`);
  if (!baseTip || !headTip) return false;
  const mb = commonAncestor(repo, baseTip, headTip);
  const mbFiles = mb ? repo.fileMap(mb) : new Map<string, string>();
  const baseFiles = repo.fileMap(baseTip);
  const headFiles = repo.fileMap(headTip);
  const changedInHead = new Set<string>();
  const changedInBase = new Set<string>();
  for (const p of new Set([...mbFiles.keys(), ...headFiles.keys()])) if (mbFiles.get(p) !== headFiles.get(p)) changedInHead.add(p);
  for (const p of new Set([...mbFiles.keys(), ...baseFiles.keys()])) if (mbFiles.get(p) !== baseFiles.get(p)) changedInBase.add(p);
  for (const p of changedInHead) {
    if (changedInBase.has(p) && headFiles.get(p) !== baseFiles.get(p)) return true;
  }
  return false;
}
/** Squash-merge a pull request. Returns the merge commit oid, or null on conflict. */
export function squashMerge(store: Store, repo: Repo, pr: PullRec): string | null {
  if (mergeConflicts(repo, pr)) return null;
  const baseTip = repo.tip(`refs/heads/${pr.baseRef}`) as string;
  const headTip = repo.tip(`refs/heads/${pr.headRef}`) as string;
  const mb = commonAncestor(repo, baseTip, headTip);
  const mbFiles = mb ? repo.fileMap(mb) : new Map<string, string>();
  const baseFiles = repo.fileMap(baseTip);
  const headFiles = repo.fileMap(headTip);
  const merged = new Map(baseFiles);
  for (const [p, oid] of headFiles) merged.set(p, oid);
  for (const p of mbFiles.keys()) if (!headFiles.has(p)) merged.delete(p);
  const treeOid = repo.buildTree(merged);
  const commitOid = repo.makeCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}\n\n${pr.title}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = new Date().toISOString();
  pr.mergeCommitSha = commitOid;
  pr.baseSha = commitOid;
  return commitOid;
}

function resolveCommit(repo: Repo, ref: string | null): string | undefined {
  if (!ref) return repo.defaultTip();
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  const byTag = repo.refs.get(`refs/tags/${ref}`);
  if (byTag) return repo.peelToCommit(byTag);
  return undefined;
}
function subtreeOid(repo: Repo, files: Map<string, string>, prefix: string): string {
  const rel = new Map<string, string>();
  for (const [p, oid] of files) if (p.startsWith(prefix)) rel.set(p.slice(prefix.length), oid);
  return repo.buildTree(rel);
}

export function handleRest(store: Store, viewer: string, method: string, pathname: string, query: URLSearchParams, body: unknown, bodyError: boolean): RestResult {
  const segs = pathname.split('/').filter((s) => s !== '');
  // segs[0..1] === api, v3
  if (bodyError) return bad('Invalid JSON body');
  const b = (body ?? {}) as Record<string, unknown>;

  if (method === 'GET' && (pathname === '/api/v3/' || pathname === '/api/v3')) {
    return { status: 200, body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, headers: { 'x-oauth-scopes': 'repo, read:org' } };
  }
  if (method === 'GET' && pathname === '/api/v3/meta') {
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (method === 'GET' && pathname === '/api/v3/user') {
    return { status: 200, body: { login: viewer, id: 1000, type: 'User', name: viewer } };
  }
  if (method === 'POST' && pathname === '/api/v3/user/repos') {
    const name = String(b.name ?? '');
    if (!name) return bad('name is required', 422);
    if (store.getRepo(viewer, name)) return bad('Repository already exists', 422);
    const repo = store.createRepo(viewer, name, b.private !== false, String(b.description ?? ''));
    return { status: 201, body: repoJson(repo) };
  }
  if (method === 'GET' && pathname === '/api/v3/user/repos') {
    const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
    const all = store.listRepos(viewer);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    if (page * perPage < all.length) {
      const base = `/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${base}>; rel="next"`;
    }
    return { status: 200, body: slice.map(repoJson), headers };
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (segs[0] === 'api' && segs[1] === 'v3' && segs[2] === 'repos' && segs.length >= 5) {
    const owner = decodeURIComponent(segs[3]);
    const name = decodeURIComponent(segs[4]);
    const repo = store.getRepo(owner, name);
    if (!repo || owner !== viewer) return notFound('Not Found');
    const rest = segs.slice(5);
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, body: repoJson(repo) };
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        return { status: 200, body: repoJson(repo) };
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return notFound();
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const ref = String(b.ref ?? '');
      const sha = String(b.sha ?? '');
      if (!ref.startsWith('refs/heads/') || !isOid(sha)) return bad('Invalid ref', 422);
      if (repo.refs.has(ref)) return bad('Reference already exists', 422);
      if (!repo.objects.has(sha)) return bad('Object does not exist', 422);
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha } } };
    }
    if (rest[0] === 'branches' && method === 'GET') {
      const out: unknown[] = [];
      for (const [ref, sha] of [...repo.refs.entries()].sort()) {
        if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
      }
      return { status: 200, body: out };
    }
    if (rest[0] === 'commits' && method === 'GET') {
      const tip = resolveCommit(repo, query.get('sha'));
      const out: unknown[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [repo.peelToCommit(tip)];
        while (stack.length > 0) {
          const cur = stack.shift() as string;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const obj = repo.objects.get(cur);
          if (!obj || obj.type !== 'commit') continue;
          const info = parseCommit(obj.data);
          // GitHub returns the message without the trailing newline the
          // stored commit object carries; the check compares it exactly.
          out.push({ sha: cur, commit: { message: info.message.replace(/\n$/, '') } });
          for (const p of info.parents) stack.push(p);
        }
      }
      return { status: 200, body: out };
    }
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'PUT') {
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const contentB64 = String(b.content ?? '');
        let content: Buffer;
        try { content = Buffer.from(contentB64, 'base64'); } catch { return bad('Invalid base64 content'); }
        const blobOid = hashObject('blob', content);
        repo.objects.set(blobOid, { type: 'blob', data: content });
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const files = tip ? repo.fileMap(tip) : new Map<string, string>();
        const existing = files.get(filePath);
        const isCreate = existing === undefined;
        if (!isCreate && typeof b.sha === 'string' && (b.sha as string).toLowerCase() !== existing.toLowerCase()) {
          return bad('sha does not match', 409);
        }
        files.set(filePath, blobOid);
        const treeOid = repo.buildTree(files);
        const parents = tip ? [tip] : [];
        const commitOid = repo.makeCommit(treeOid, parents, String(b.message ?? `Update ${filePath}`));
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        return { status: isCreate ? 201 : 200, body: { content: { sha: blobOid, encoding: 'base64' }, commit: { sha: commitOid } } };
      }
      if (method === 'GET') {
        const tip = resolveCommit(repo, query.get('ref'));
        if (!tip) return notFound('Not Found');
        const files = repo.fileMap(tip);
        if (files.has(filePath)) {
          const oid = files.get(filePath) as string;
          const data = repo.objects.get(oid)?.data ?? Buffer.alloc(0);
          return { status: 200, body: { type: 'file', encoding: 'base64', content: data.toString('base64'), sha: oid, size: data.length, name: filePath.split('/').pop(), path: filePath } };
        }
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const children = new Map<string, { dir: boolean; oid: string }>();
        for (const [p, oid] of files) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash === -1) children.set(restPath, { dir: false, oid });
          else {
            const dir = restPath.slice(0, slash);
            if (!children.has(dir)) children.set(dir, { dir: true, oid: subtreeOid(repo, files, `${prefix}${dir}/`) });
          }
        }
        if (children.size === 0) return notFound('Not Found');
        const out: unknown[] = [];
        for (const [name, c] of [...children.entries()].sort()) {
          out.push({ type: c.dir ? 'dir' : 'file', name, path: `${prefix}${name}`, sha: c.oid, ...(c.dir ? {} : { size: (repo.objects.get(c.oid)?.data.length ?? 0) }) });
        }
        return { status: 200, body: out };
      }
      if (method === 'DELETE') {
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return notFound('Not Found');
        const files = repo.fileMap(tip);
        const existing = files.get(filePath);
        if (existing === undefined) return notFound('Not Found');
        if (typeof b.sha === 'string' && (b.sha as string).toLowerCase() !== existing.toLowerCase()) {
          return bad('sha does not match', 409);
        }
        files.delete(filePath);
        const treeOid = repo.buildTree(files);
        const commitOid = repo.makeCommit(treeOid, [tip], String(b.message ?? `Delete ${filePath}`));
        repo.refs.set(`refs/heads/${branch}`, commitOid);
        return { status: 200, body: { commit: { sha: commitOid } } };
      }
      return notFound();
    }
    if (rest[0] === 'labels' && method === 'POST') {
      const name = String(b.name ?? '');
      const color = String(b.color ?? 'ededed');
      if (!name) return bad('name is required', 422);
      repo.labels.set(name, { name, color });
      return { status: 201, body: { name, color } };
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map(String) : [];
          for (const l of labels) if (!repo.labels.has(l)) return bad(`Label ${l} does not exist`, 422);
          const issue: IssueRec = {
            number: repo.nextIssue, title: String(b.title ?? ''), body: String(b.body ?? ''),
            state: 'open', labels, comments: [], seq: repo.seq,
          };
          repo.nextIssue += 1; repo.seq += 1;
          repo.issues.push(issue);
          return { status: 201, body: issueJson(repo, issue) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          const sort = query.get('sort') ?? 'created';
          const dir = query.get('direction') ?? 'desc';
          if (sort === 'created') list.sort((a, c) => (dir === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          return { status: 200, body: list.slice(0, perPage).map((i) => issueJson(repo, i)) };
        }
      }
      const num = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) return notFound('Not Found');
        if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return { status: 200, body: issueJson(repo, issue) };
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) return notFound('Not Found');
        if (method === 'POST') {
          const comment = { id: repo.nextComment, body: String(b.body ?? '') };
          repo.nextComment += 1;
          issue.comments.push(comment);
          return { status: 201, body: comment };
        }
        if (method === 'GET') return { status: 200, body: issue.comments.map((c) => ({ id: c.id, body: c.body })) };
      }
      return notFound();
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const headRef = String(b.head ?? '');
          const baseRef = String(b.base ?? '');
          const headTip = repo.refs.get(`refs/heads/${headRef}`);
          const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headTip || !baseTip) return bad('Head or base branch does not exist', 422);
          const pr: PullRec = {
            number: repo.nextPull, title: String(b.title ?? ''), body: String(b.body ?? ''),
            state: 'open', headRef, baseRef, headSha: headTip, baseSha: baseTip,
            merged: false, mergedAt: null, mergeCommitSha: null, baseTipAtCreate: baseTip, seq: repo.seq,
          };
          repo.nextPull += 1; repo.seq += 1;
          repo.pulls.push(pr);
          return { status: 201, body: pullJson(repo, pr) };
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          return { status: 200, body: list.slice(0, perPage).map((p) => pullJson(repo, p)) };
        }
      }
      const num = Number.parseInt(rest[1], 10);
      const pr = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pr) return notFound('Not Found');
        if (method === 'GET') return { status: 200, body: pullJson(repo, pr) };
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pr) return notFound('Not Found');
        return { status: 200, body: diffFiles(repo, pr.baseSha, pr.headSha) };
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pr) return notFound('Not Found');
        if (pr.merged || pr.state === 'closed') return bad('Pull request is already closed', 405);
        const sha = squashMerge(store, repo, pr);
        if (sha === null) return bad('Merge conflict', 405);
        return { status: 200, body: { merged: true, sha, message: 'Pull request successfully merged' } };
      }
      return notFound();
    }
    return notFound();
  }
  return notFound();
}

export { viewerLogin };
