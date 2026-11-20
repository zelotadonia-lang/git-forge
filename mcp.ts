// Model Context Protocol endpoint (POST /mcp): JSON-RPC 2.0 over Streamable
// HTTP, modern revision 2026-07-28 with a legacy initialize fallback. The six
// tools act on the same store as REST and GraphQL. No exec/eval/filesystem
// from input; ids are echoed exactly as received.

import {
  issueGlobalId,
  mergePullRequest,
  pullGlobalId,
  viewerLogin,
} from './forge.ts';
import { resolveRepo, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export interface McpHttpRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface McpHttpResponse {
  status: number;
  contentType: string;
  body: string;
}

function jsonResponse(status: number, body: unknown): McpHttpResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Pull a JSON-RPC id out of a body that failed to parse (for -32700 answers). */
function extractId(raw: string): JsonRpcId {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (match === null) return null;
  const token = match[1] as string;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return null;
    }
  }
  const num = Number(token);
  return Number.isFinite(num) ? num : null;
}

// ---------------------------------------------------------------------------
// Tools (one frozen definition; tools/list must be byte-identical per call)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Match a tool by exact name, then by normalized suffix (server prefixes allowed). */
function findTool(name: string): ToolDef | undefined {
  const exact = TOOLS.find((tool) => tool.name === name);
  if (exact !== undefined) return exact;
  const wanted = normalizeName(name);
  return TOOLS.find((tool) => {
    const candidate = normalizeName(tool.name);
    return wanted === candidate || (wanted.length > candidate.length && wanted.endsWith(candidate));
  });
}

/**
 * Pick a property from arguments by any of its accepted names (the suite maps
 * each argument onto the nearest property name). Returns undefined when none
 * is present.
 */
function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  const byNormalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(args)) byNormalized.set(normalizeName(key), value);
  for (const name of names) {
    const value = byNormalized.get(normalizeName(name));
    if (value !== undefined) return value;
  }
  return undefined;
}

function toolOk(structured: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

function toolFail(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoSummary(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? viewerLogin(store) ?? '';
  return {
    id: repo.seq,
    name: repo.name,
    full_name: owner === '' ? repo.name : `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function resolveToolRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const fullName = pickArg(args, ['full_name', 'repo_full_name', 'repository_full_name']);
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, ...rest] = fullName.split('/');
    const repo = resolveRepo(store, owner as string, rest.join('/'));
    if (repo !== null) return repo;
  }
  const owner = pickArg(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace']);
  const repoName = pickArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'name']);
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  return resolveRepo(store, owner, repoName);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) throw new McpError(-32602, `Unknown tool "${name}".`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = pickArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (typeof repoName !== 'string' || repoName === '') return toolFail('create_repo requires a "name" string.');
      const description = pickArg(args, ['description', 'about', 'summary', 'body']);
      const isPrivate = pickArg(args, ['private', 'is_private']) === true;
      const repo = store.createRepo(repoName, typeof description === 'string' ? description : '', isPrivate);
      if (repo === null) return toolFail(`Repository "${repoName}" already exists.`);
      const login = viewerLogin(store);
      if (login !== null) repo.owner = login;
      return toolOk(repoSummary(store, repo));
    }
    case 'get_repo': {
      const repo = resolveToolRepo(store, args);
      if (repo === null) return toolFail('Repository not found.');
      return toolOk(repoSummary(store, repo));
    }
    case 'create_issue': {
      const repo = resolveToolRepo(store, args);
      if (repo === null) return toolFail('create_issue requires "owner" and "repo" naming an existing repository.');
      const title = pickArg(args, ['title', 'issue_title', 'subject']);
      if (typeof title !== 'string' || title === '') return toolFail('create_issue requires a "title" string.');
      const body = pickArg(args, ['body', 'issue_body', 'description', 'content', 'text']);
      const issue = {
        number: repo.nextIssue,
        title,
        body: typeof body === 'string' ? body : '',
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as { id: number; body: string }[],
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return toolOk({
        id: issueGlobalId(repo, issue),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: 'open',
        repository: repo.name,
      });
    }
    case 'list_issues': {
      const repo = resolveToolRepo(store, args);
      if (repo === null) return toolFail('list_issues requires "owner" and "repo" naming an existing repository.');
      const state = pickArg(args, ['state', 'status']);
      const wanted = typeof state === 'string' ? state.toLowerCase() : 'open';
      const list = repo.issues
        .filter((issue) => wanted === 'all' || issue.state === wanted)
        .map((issue) => ({ id: issueGlobalId(repo, issue), number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return toolOk({ issues: list });
    }
    case 'create_pull_request': {
      const repo = resolveToolRepo(store, args);
      if (repo === null) return toolFail('create_pull_request requires "owner" and "repo" naming an existing repository.');
      const title = pickArg(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickArg(args, ['head', 'head_ref', 'head_branch', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = pickArg(args, ['base', 'base_ref', 'base_branch', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      if (typeof title !== 'string' || title === '') return toolFail('create_pull_request requires a "title" string.');
      if (typeof head !== 'string' || head === '') return toolFail('create_pull_request requires a "head" branch.');
      if (typeof base !== 'string' || base === '') return toolFail('create_pull_request requires a "base" branch.');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolFail('head or base branch not found');
      const body = pickArg(args, ['body', 'description', 'content', 'text']);
      const pr = {
        number: repo.nextPull,
        title,
        body: typeof body === 'string' ? body : '',
        state: 'open' as const,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null as string | null,
        mergeCommitSha: null as string | null,
      };
      repo.nextPull += 1;
      repo.pulls.push(pr);
      return toolOk({
        id: pullGlobalId(repo, pr),
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: 'open',
        merged: false,
        head: { ref: head, sha: headSha, label: head },
        base: { ref: base, sha: baseSha, label: base },
        headRefName: head,
        baseRefName: base,
      });
    }
    case 'merge_pull_request': {
      const repo = resolveToolRepo(store, args);
      if (repo === null) return toolFail('merge_pull_request requires "owner" and "repo" naming an existing repository.');
      const pullNumber = pickArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      if (typeof pullNumber !== 'number' || !Number.isInteger(pullNumber)) {
        return toolFail('merge_pull_request requires a "pull_number" integer.');
      }
      const pr = repo.pulls.find((candidate) => candidate.number === pullNumber);
      if (pr === undefined) return toolFail(`Pull request #${pullNumber} not found.`);
      const result = mergePullRequest(repo, pr);
      if (!result.ok) return toolFail(result.reason);
      return toolOk({ id: pullGlobalId(repo, pr), number: pr.number, merged: true, state: 'closed', sha: result.sha });
    }
    default:
      throw new McpError(-32602, `Unknown tool "${name}".`);
  }
}

class McpError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

function serverInfoBlock(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

function dispatch(store: Store, token: string | null, headers: Record<string, string | undefined>, request: Record<string, unknown>): { status: number; payload: Record<string, unknown> | null } {
  const id = (request.id === undefined ? null : request.id) as JsonRpcId;
  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    return { status: 200, payload: rpcError(id, -32600, 'Invalid Request: method is required.') };
  }
  const isNotification = request.id === undefined;

  // Notifications get no JSON-RPC answer (202, empty body).
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, payload: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      payload: rpcResult(id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: serverInfoBlock(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfoBlock() },
      }),
    };
  }

  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = LEGACY_REVISIONS.includes(offered) ? offered : LEGACY_REVISIONS[0];
    return {
      status: 200,
      payload: rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: serverInfoBlock(),
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, payload: rpcResult(id, {}) };
  }

  if (method === 'tools/list') {
    // The same frozen array every call: byte-identical responses.
    return { status: 200, payload: rpcResult(id, { tools: TOOLS }) };
  }

  if (method === 'tools/call') {
    // Auth is decided before the tool is looked up: no token, 401, any tool.
    if (token !== null && headers.authorization !== `Bearer ${token}`) {
      return { status: 401, payload: null };
    }
    const params = isRecord(request.params) ? request.params : {};
    const toolName = params.name;
    if (typeof toolName !== 'string' || toolName === '') {
      return { status: 200, payload: rpcError(id, -32602, 'Invalid params: tools/call requires a "name" string.') };
    }
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = callTool(store, toolName, args);
      return { status: 200, payload: rpcResult(id, result) };
    } catch (err) {
      if (err instanceof McpError) return { status: 200, payload: rpcError(id, err.code, err.message) };
      return { status: 200, payload: rpcError(id, -32603, 'Internal error.') };
    }
  }

  return { status: 200, payload: rpcError(id, -32601, `Method not found: ${method}`) };
}

export function handleMcp(store: Store, token: string | null, req: McpHttpRequest): McpHttpResponse {
  if (req.method === 'DELETE') {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed.' } });
  }
  const raw = req.body.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // Not JSON: HTTP 400 with a -32700 JSON-RPC error carrying the id when readable.
    return jsonResponse(400, rpcError(extractId(raw), -32700, 'Parse error: request body is not valid JSON.'));
  }
  if (!isRecord(parsed)) {
    return jsonResponse(400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object.'));
  }
  const { status, payload } = dispatch(store, token, req.headers, parsed);
  if (status === 401) {
    return jsonResponse(401, { message: 'Unauthorized' });
  }
  if (payload === null) {
    return { status, contentType: 'application/json; charset=utf-8', body: '' };
  }
  return jsonResponse(status, payload);
}
