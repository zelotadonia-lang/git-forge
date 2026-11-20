// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, modern
// revision 2026-07-28 via server/discover, with the legacy initialize
// handshake as a fallback. Tools act on the same store as REST/GraphQL.

import {
  VIEWER,
  globalId,
  type Repo,
  type Store,
} from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  mergePullRecord,
} from './rest.ts';

export interface McpResult {
  status: number;
  headers?: Record<string, string>;
  body: Buffer | null;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

// One frozen list: two tools/list calls must answer byte for byte the same.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const CANONICAL = ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'];

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveTool(name: string): string | null {
  const n = normalize(name);
  for (const c of CANONICAL) {
    if (n === normalize(c)) return c;
    if (n.endsWith(normalize(c)) && n.length > normalize(c).length) return c;
  }
  return null;
}

function jsonRpc(id: unknown, result: unknown): McpResult {
  return { status: 200, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8') };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, 'utf8') };
}

function toolResult(id: unknown, structured: unknown): McpResult {
  const text = JSON.stringify(structured);
  return jsonRpc(id, {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    isError: false,
  });
}

function toolError(id: unknown, message: string): McpResult {
  return jsonRpc(id, {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    isError: true,
  });
}

function tokenOk(auth: string | undefined): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (!expected) return !!auth && auth.startsWith('Bearer ') && auth.length > 7;
  return auth === `Bearer ${expected}`;
}

/** owner/repo from arguments, accepting full_name as a fallback. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args['owner'] === 'string' ? args['owner'] : '';
  let repo = typeof args['repo'] === 'string' ? args['repo'] : '';
  if ((!owner || !repo) && typeof args['full_name'] === 'string') {
    const parts = (args['full_name'] as string).split('/');
    if (parts.length === 2) {
      owner = parts[0]!;
      repo = parts[1]!;
    }
  }
  return { owner, repo };
}

function requireArgs(id: unknown, args: Record<string, unknown>, required: string[]): McpResult | null {
  for (const r of required) {
    const v = args[r];
    if (v === undefined || v === null || v === '') {
      return toolError(id, `missing required argument: ${r}`);
    }
  }
  return null;
}

export function handleMcp(store: Store, rawBody: Buffer, headers: Record<string, string | undefined>): McpResult {
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Parse error: HTTP 400 + -32700; recover the id when it is visible.
    const m = text.match(/"id"\s*:\s*(\d+|"[^"]*")/);
    let id: unknown = null;
    if (m) {
      try {
        id = JSON.parse(m[1]!);
      } catch {
        id = null;
      }
    }
    return jsonRpcError(id, -32700, 'Parse error', 400);
  }
  const req = (parsed ?? {}) as Record<string, unknown>;
  const id = req['id'] ?? null;
  const method = typeof req['method'] === 'string' ? req['method'] : '';
  const params = (req['params'] ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return jsonRpc(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'initialize') {
    const offered = params['protocolVersion'];
    const offeredList = Array.isArray(params['protocolVersions']) ? (params['protocolVersions'] as string[]) : [];
    const pick =
      (typeof offered === 'string' && offered ? offered : undefined) ??
      offeredList[0] ??
      '2025-11-25';
    return jsonRpc(id, {
      protocolVersion: pick,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification has no id and expects no reply.
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return jsonRpc(id, {});
  }
  if (method === 'tools/list') {
    return jsonRpc(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    // Auth is decided before the tool is looked up.
    if (!tokenOk(headers['authorization'])) {
      return { status: 401, body: Buffer.from('{"message":"Requires authentication"}\n', 'utf8') };
    }
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    const canonical = resolveTool(name);
    if (!canonical) {
      return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
    }
    if (canonical === 'create_repo') {
      const missing = requireArgs(id, args, ['name']);
      if (missing) return missing;
      const repoName = String(args['name']);
      if (store.getRepo(VIEWER.login, repoName)) {
        return toolError(id, 'Repository already exists');
      }
      const repo: Repo = store.createRepo(VIEWER.login, repoName, typeof args['description'] === 'string' ? args['description'] : '', args['private'] === true);
      const structured = {
        id: repo.id,
        node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      };
      return toolResult(id, structured);
    }
    const { owner, repo: repoName } = ownerRepo(args);
    if (canonical === 'get_repo') {
      const missing = requireArgs(id, args, ['owner', 'repo']);
      if (missing) return missing;
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, 'Repository not found');
      return toolResult(id, {
        id: repo.id,
        node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: repo.owner,
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      });
    }
    const repo = store.getRepo(owner, repoName);
    if (canonical === 'create_issue') {
      const missing = requireArgs(id, args, ['owner', 'repo', 'title']);
      if (missing) return missing;
      if (!repo) return toolError(id, 'Repository not found');
      const issue = createIssueRecord(repo, String(args['title']), typeof args['body'] === 'string' ? args['body'] : '', []);
      return toolResult(id, {
        id: repo.id * 1000000 + issue.number,
        node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    if (canonical === 'list_issues') {
      const missing = requireArgs(id, args, ['owner', 'repo']);
      if (missing) return missing;
      if (!repo) return toolError(id, 'Repository not found');
      const state = typeof args['state'] === 'string' ? args['state'].toLowerCase() : 'all';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const structured = list.map((i) => ({
        id: repo.id * 1000000 + i.number,
        node_id: globalId('Issue', `${repo.owner}/${repo.name}#${i.number}`),
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      }));
      return toolResult(id, { issues: structured, full_name: `${repo.owner}/${repo.name}` });
    }
    if (canonical === 'create_pull_request') {
      const missing = requireArgs(id, args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return missing;
      if (!repo) return toolError(id, 'Repository not found');
      const pr = createPullRecord(repo, String(args['head']), String(args['base']), String(args['title']), typeof args['body'] === 'string' ? args['body'] : '');
      if (!pr) return toolError(id, 'head or base branch does not exist');
      return toolResult(id, {
        id: repo.id * 1000000 + pr.number,
        node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`),
        number: pr.number,
        title: pr.title,
        state: pr.state,
        head: pr.head,
        base: pr.base,
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    if (canonical === 'merge_pull_request') {
      const missing = requireArgs(id, args, ['owner', 'repo', 'pull_number']);
      if (missing) return missing;
      if (!repo) return toolError(id, 'Repository not found');
      const n = typeof args['pull_number'] === 'number' ? args['pull_number'] : Number.parseInt(String(args['pull_number']), 10);
      const pr = repo.pulls.get(n);
      if (!pr) return toolError(id, 'Pull request not found');
      const result = mergePullRecord(store, repo, pr);
      if (result.status !== 200) return toolError(id, result.message);
      return toolResult(id, {
        merged: true,
        number: pr.number,
        sha: result.sha,
        state: pr.state,
        full_name: `${repo.owner}/${repo.name}`,
      });
    }
    return jsonRpcError(id, -32602, `Unknown tool: ${name}`);
  }
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
