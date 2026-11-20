// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp).
// Speaks the modern revision 2026-07-28: server/discover, tools/list and
// tools/call, all on the same store as REST. JSON-RPC 2.0 ids are echoed
// exactly (including string ids), unknown tools answer -32602, a non-JSON
// body answers HTTP 400 with -32700, and tools/call without Authorization
// answers 401.
import { squashMerge } from './rest.ts';
import { viewerLogin, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';

export interface McpResult { status: number; body: unknown }

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full repository name owner/repo' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

const CANONICAL = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];
const ALIASES: Record<string, string[]> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};
function norm(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function matchTool(name: string): string | null {
  const n = norm(name);
  for (const c of CANONICAL) {
    if (n === norm(c)) return c;
    for (const a of ALIASES[c] ?? []) if (n === norm(a)) return c;
    if (n.length > norm(c).length && n.endsWith(norm(c))) return c;
  }
  return null;
}
function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}
function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}
function toolResult(structured: unknown, text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: 'text', text }], structuredContent: structured, ...(isError ? { isError: true } : {}) };
}
function splitFullName(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = String(args.owner ?? args.owner_login ?? args.org ?? args.login ?? '');
  let repo = String(args.repo ?? args.repository ?? args.repository_name ?? args.repo_name ?? '');
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) { owner = owner || parts[0]; repo = repo || parts[1]; }
  }
  if ((!owner || !repo) && typeof args.fullName === 'string') {
    const parts = (args.fullName as string).split('/');
    if (parts.length === 2) { owner = owner || parts[0]; repo = repo || parts[1]; }
  }
  return { owner, repo };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return { id: repo.id, name: repo.name, full_name: repo.fullName, owner: repo.owner, private: repo.isPrivate, description: repo.description, default_branch: repo.defaultBranch };
}

export function handleMcp(store: Store, viewer: string, method: string, rawBody: Buffer, authed: boolean): McpResult {
  if (method === 'DELETE') return { status: 200, body: { ok: true } };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    if (req === null || typeof req !== 'object' || Array.isArray(req)) throw new Error('not an object');
  } catch {
    // Parse error: HTTP 400 with -32700; echo the id when it can be read.
    let id: unknown = null;
    const m = /"id"\s*:\s*("[^"]*"|\d+)/.exec(rawBody.toString('utf8'));
    if (m) {
      try { id = JSON.parse(m[1]); } catch { id = null; }
    }
    return { status: 400, body: { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = ('id' in req ? req.id : null) as unknown;
  const rpcMethod = String(req.method ?? '');
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (rpcMethod === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
    });
  }
  if (rpcMethod === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: { name: 'git-forge', version: '1.0.0' },
    });
  }
  if (rpcMethod === 'notifications/initialized' || rpcMethod.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (rpcMethod === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (rpcMethod === 'tools/call') {
    if (!authed) return { status: 401, body: { message: 'Unauthorized' } };
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = matchTool(name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const missing = (need: string[]): boolean => need.some((k) => args[k] === undefined || args[k] === null || args[k] === '');
    switch (tool) {
      case 'create_repo': {
        if (missing(['name'])) return rpcResult(id, toolResult(null, 'Missing required argument: name', true));
        const repoName = String(args.name);
        if (store.getRepo(viewer, repoName)) return rpcResult(id, toolResult(null, `Repository ${viewer}/${repoName} already exists`, true));
        const repo = store.createRepo(viewer, repoName, args.private !== false, String(args.description ?? ''));
        const out = repoJson(repo);
        return rpcResult(id, toolResult(out, JSON.stringify(out)));
      }
      case 'get_repo': {
        const { owner, repo: repoName } = splitFullName(args);
        if (!owner || !repoName) return rpcResult(id, toolResult(null, 'Missing required argument: owner/repo', true));
        const repo = store.getRepo(owner, repoName);
        if (!repo) return rpcResult(id, toolResult(null, `Repository ${owner}/${repoName} not found`, true));
        const out = repoJson(repo);
        return rpcResult(id, toolResult(out, JSON.stringify(out)));
      }
      case 'create_issue': {
        const { owner, repo: repoName } = splitFullName(args);
        if (!owner || !repoName || !args.title) return rpcResult(id, toolResult(null, 'Missing required argument: owner, repo or title', true));
        const repo = store.getRepo(owner, repoName);
        if (!repo) return rpcResult(id, toolResult(null, `Repository ${owner}/${repoName} not found`, true));
        const issue: IssueRec = { number: repo.nextIssue, title: String(args.title), body: String(args.body ?? ''), state: 'open', labels: [], comments: [], seq: repo.seq };
        repo.nextIssue += 1; repo.seq += 1;
        repo.issues.push(issue);
        const out = { id: store.gid('I', repo, issue.number), number: issue.number, title: issue.title, body: issue.body, state: 'open', full_name: repo.fullName };
        return rpcResult(id, toolResult(out, JSON.stringify(out)));
      }
      case 'list_issues': {
        const { owner, repo: repoName } = splitFullName(args);
        if (!owner || !repoName) return rpcResult(id, toolResult(null, 'Missing required argument: owner/repo', true));
        const repo = store.getRepo(owner, repoName);
        if (!repo) return rpcResult(id, toolResult(null, `Repository ${owner}/${repoName} not found`, true));
        const state = String(args.state ?? 'open').toLowerCase();
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        const items = list.map((i) => ({ id: store.gid('I', repo, i.number), number: i.number, title: i.title, body: i.body, state: i.state }));
        const out = { issues: items };
        return rpcResult(id, toolResult(out, JSON.stringify(items)));
      }
      case 'create_pull_request': {
        const { owner, repo: repoName } = splitFullName(args);
        const head = String(args.head ?? args.head_ref ?? args.head_branch ?? '');
        const base = String(args.base ?? args.base_ref ?? args.base_branch ?? '');
        if (!owner || !repoName || !args.title || !head || !base) return rpcResult(id, toolResult(null, 'Missing required argument: owner, repo, title, head or base', true));
        const repo = store.getRepo(owner, repoName);
        if (!repo) return rpcResult(id, toolResult(null, `Repository ${owner}/${repoName} not found`, true));
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (!headTip || !baseTip) return rpcResult(id, toolResult(null, 'Head or base branch does not exist', true));
        const pr: PullRec = {
          number: repo.nextPull, title: String(args.title), body: String(args.body ?? ''),
          state: 'open', headRef: head, baseRef: base, headSha: headTip, baseSha: baseTip,
          merged: false, mergedAt: null, mergeCommitSha: null, baseTipAtCreate: baseTip, seq: repo.seq,
        };
        repo.nextPull += 1; repo.seq += 1;
        repo.pulls.push(pr);
        const out = { id: store.gid('PR', repo, pr.number), number: pr.number, title: pr.title, state: 'open', head: { ref: head }, base: { ref: base }, headRefName: head, baseRefName: base, full_name: repo.fullName };
        return rpcResult(id, toolResult(out, JSON.stringify(out)));
      }
      case 'merge_pull_request': {
        const { owner, repo: repoName } = splitFullName(args);
        const num = Number(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
        if (!owner || !repoName || !Number.isFinite(num)) return rpcResult(id, toolResult(null, 'Missing required argument: owner, repo or pull_number', true));
        const repo = store.getRepo(owner, repoName);
        if (!repo) return rpcResult(id, toolResult(null, `Repository ${owner}/${repoName} not found`, true));
        const pr = repo.pulls.find((p) => p.number === num);
        if (!pr) return rpcResult(id, toolResult(null, `Pull request ${num} not found`, true));
        if (pr.merged || pr.state === 'closed') return rpcResult(id, toolResult(null, 'Pull request is already closed', true));
        const sha = squashMerge(store, repo, pr);
        if (sha === null) return rpcResult(id, toolResult(null, 'Merge conflict', true));
        const out = { number: pr.number, merged: true, sha, state: 'closed', full_name: repo.fullName };
        return rpcResult(id, toolResult(out, JSON.stringify(out)));
      }
      default:
        return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
  }
  return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
}

export { viewerLogin };
