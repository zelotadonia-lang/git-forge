// graphql.ts — a small hand-written GraphQL parser + executor for the exact
// documents the suite sends (gh / github-mcp-server), over the shared store.
// No GraphQL library; Node stdlib only. Unknown fields are GraphQL errors
// (HTTP 200 + errors[]), an unknown repository is data.repository = null
// with no errors, and a missing token is HTTP 401 (handled by app.ts).
import { diffFiles, mergeConflicts, squashMerge } from './rest.ts';
import { viewerLogin, type IssueRec, type PullRec, type Repo, type Store } from './store.ts';

const MAX_DEPTH = 100;
const MAX_QUERY_LEN = 1024 * 1024;

// --- tokenizer ----------------------------------------------------------------
type Tok = { kind: 'name' | 'string' | 'int' | 'punct' | 'spread'; value: string };
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j]; j += 1; }
      }
      if (j >= src.length) throw new Error('unterminated string');
      out.push({ kind: 'string', value: s });
      i = j + 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { out.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$'.includes(c)) { out.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      out.push({ kind: 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${c}`);
  }
  return out;
}

// --- parser -------------------------------------------------------------------
export interface FieldNode { alias: string | null; name: string; args: Record<string, unknown>; children: FieldNode[]; fragmentType: string | null }
interface OpDef { kind: 'query' | 'mutation'; name: string | null; vars: Record<string, unknown>; fields: FieldNode[] }
function parseDocument(src: string): OpDef[] {
  const toks = tokenize(src);
  let pos = 0;
  const peek = (): Tok | undefined => toks[pos];
  const next = (): Tok => {
    const t = toks[pos];
    if (!t) throw new Error('unexpected end');
    pos += 1;
    return t;
  };
  const expectPunct = (v: string): void => {
    const t = next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  };
  const parseValue = (vars: Record<string, unknown>): unknown => {
    const t = next();
    if (t.kind === 'punct' && t.value === '$') {
      const name = next();
      return { __var: name.value };
    }
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return Number.parseInt(t.value, 10);
    if (t.kind === 'punct' && t.value === '[') {
      const arr: unknown[] = [];
      while (!(peek()?.kind === 'punct' && peek()?.value === ']')) arr.push(parseValue(vars));
      expectPunct(']');
      return arr;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(peek()?.kind === 'punct' && peek()?.value === '}')) {
        const k = next();
        expectPunct(':');
        obj[k.value] = parseValue(vars);
      }
      expectPunct('}');
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    throw new Error('bad value');
  };
  const parseArgs = (vars: Record<string, unknown>): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    if (peek()?.kind === 'punct' && peek()?.value === '(') {
      next();
      while (!(peek()?.kind === 'punct' && peek()?.value === ')')) {
        const k = next();
        expectPunct(':');
        args[k.value] = parseValue(vars);
      }
      expectPunct(')');
    }
    return args;
  };
  const parseSelection = (vars: Record<string, unknown>, depth: number): FieldNode[] => {
    if (depth > MAX_DEPTH) throw new Error('query too deep');
    expectPunct('{');
    const fields: FieldNode[] = [];
    while (!(peek()?.kind === 'punct' && peek()?.value === '}')) {
      const t = next();
      if (t.kind === 'spread') {
        // ... on Type { ... } — inline fragment.
        let fragType: string | null = null;
        if (peek()?.kind === 'name' && peek()?.value === 'on') {
          next();
          fragType = next().value;
        }
        const children = parseSelection(vars, depth + 1);
        fields.push({ alias: null, name: '__fragment', args: {}, children, fragmentType: fragType });
        continue;
      }
      let alias: string | null = null;
      let name = t.value;
      if (peek()?.kind === 'punct' && peek()?.value === ':') {
        next();
        alias = name;
        name = next().value;
      }
      const args = parseArgs(vars);
      let children: FieldNode[] = [];
      if (peek()?.kind === 'punct' && peek()?.value === '{') children = parseSelection(vars, depth + 1);
      fields.push({ alias, name, args, children, fragmentType: null });
    }
    expectPunct('}');
    return fields;
  };
  const ops: OpDef[] = [];
  while (pos < toks.length) {
    let kind: 'query' | 'mutation' = 'query';
    const t = next();
    if (t.kind === 'punct' && t.value === '{') {
      pos -= 1;
      ops.push({ kind: 'query', name: null, vars: {}, fields: parseSelection({}, 0) });
      continue;
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value as 'query' | 'mutation';
      let name: string | null = null;
      if (peek()?.kind === 'name') name = next().value;
      const vars: Record<string, unknown> = {};
      if (peek()?.kind === 'punct' && peek()?.value === '(') {
        next();
        while (!(peek()?.kind === 'punct' && peek()?.value === ')')) {
          const dollar = next();
          if (dollar.kind === 'punct' && dollar.value === '$') {
            const vname = next().value;
            expectPunct(':');
            // Skip the type annotation (possibly with ! or [..]).
            let depth = 0;
            for (;;) {
              const tt = next();
              if (tt.kind === 'punct' && tt.value === '[') depth += 1;
              else if (tt.kind === 'punct' && tt.value === ']') depth -= 1;
              else if (tt.kind === 'punct' && (tt.value === ',' || tt.value === ')')) { pos -= 1; break; }
              else if (tt.kind === 'punct' && tt.value === '!') { /* continue */ }
              else if (depth === 0 && tt.kind === 'name') { /* type name, keep scanning for , or ) */ }
              if (peek()?.kind === 'punct' && peek()?.value === '=') {
                // Default value: skip one value.
                next();
                parseValue(vars);
              }
              if (peek() === undefined) break;
              const pk = peek() as Tok;
              if (depth === 0 && pk.kind === 'punct' && (pk.value === ',' || pk.value === ')')) break;
            }
            vars[vname] = null;
          } else if (dollar.kind === 'punct' && dollar.value === ',') {
            continue;
          } else {
            throw new Error('bad variable definition');
          }
        }
        expectPunct(')');
      }
      const fields = parseSelection(vars, 0);
      ops.push({ kind, name, vars, fields });
      continue;
    }
    throw new Error('bad document');
  }
  return ops;
}

function resolveValue(v: unknown, variables: Record<string, unknown>): unknown {
  if (v !== null && typeof v === 'object') {
    if ('__var' in (v as Record<string, unknown>)) {
      const name = (v as Record<string, unknown>).__var as string;
      return variables[name] ?? null;
    }
    if ('__enum' in (v as Record<string, unknown>)) return (v as Record<string, unknown>).__enum;
    if (Array.isArray(v)) return v.map((x) => resolveValue(x, variables));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = resolveValue(val, variables);
    return out;
  }
  return v;
}

// --- schema tables for validation + introspection ------------------------------
const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PACKAGE', 'MARKETPLACE_LISTING', 'APP'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

class GqlError extends Error {}

// --- executor -------------------------------------------------------------------
interface Ctx { store: Store; viewer: string }
function err(msg: string): never { throw new GqlError(msg); }

function issueGid(ctx: Ctx, repo: Repo, issue: IssueRec): string { return ctx.store.gid('I', repo, issue.number); }
function prGid(ctx: Ctx, repo: Repo, pr: PullRec): string { return ctx.store.gid('PR', repo, pr.number); }
function repoGid(ctx: Ctx, repo: Repo): string { return ctx.store.gid('R', repo, 0); }
function commentGid(ctx: Ctx, repo: Repo, issue: IssueRec, commentId: number): string { return ctx.store.gid('IC', repo, issue.number * 100000 + commentId); }

function validateFields(type: string, fields: FieldNode[]): void {
  const allowed = FIELDS[type];
  if (!allowed) return;
  for (const f of fields) {
    if (f.name === '__fragment') { validateFields(type, f.children); continue; }
    if (!allowed.includes(f.name)) err(`Cannot query field "${f.name}" on type "${type}".`);
    validateChildren(type, f);
  }
}
function validateChildren(parentType: string, field: FieldNode): void {
  if (field.children.length === 0) return;
  const childType: Record<string, string> = {
    viewer: 'User', repository: 'Repository', node: 'Node', owner: 'User', defaultBranchRef: 'Ref',
    issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest', nodes: 'NodeItem', pageInfo: 'PageInfo', files: 'PullRequestChangedFileConnection',
    __type: '__Type', fields: '__Field', enumValues: '__EnumValue',
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload', commentEdge: 'IssueCommentEdge',
  };
  const ct = field.name === 'node' && parentType === 'IssueCommentEdge'
    ? 'IssueComment'
    : childType[field.name];
  if (!ct) return;
  if (ct === 'NodeItem') {
    // nodes of a connection: type depends on the parent connection.
    const itemType = parentType === 'IssueConnection' ? 'Issue' : parentType === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
    validateFields(itemType, field.children);
    return;
  }
  if (ct === 'Node') {
    for (const f of field.children) {
      if (f.name === '__fragment') {
        if (f.fragmentType === 'Repository') validateFields('Repository', f.children);
        continue;
      }
      if (f.name !== 'id') err(`Cannot query field "${f.name}" on type "Node".`);
    }
    return;
  }
  validateFields(ct, field.children);
}

function repoFields(ctx: Ctx, repo: Repo, fields: FieldNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.args)) args[k] = resolveValue(v, variables);
    switch (f.name) {
      case 'id': out[key] = repoGid(ctx, repo); break;
      case 'databaseId': out[key] = repo.id; break;
      case 'name': out[key] = repo.name; break;
      case 'nameWithOwner': out[key] = repo.fullName; break;
      case 'owner': out[key] = selectFields('User', { login: repo.owner, id: 1000 }, f.children); break;
      case 'defaultBranchRef': out[key] = selectFields('Ref', { name: repo.defaultBranch }, f.children); break;
      case 'viewerPermission': out[key] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[key] = true; break;
      case 'issue': {
        const issue = repo.issues.find((i) => i.number === args.number);
        out[key] = issue ? issueFields(ctx, repo, issue, f.children) : null;
        break;
      }
      case 'issues': out[key] = issuesConnection(ctx, repo, f, args); break;
      case 'pullRequests': out[key] = prsConnection(ctx, repo, f, args); break;
      case 'pullRequest': {
        const pr = repo.pulls.find((p) => p.number === args.number);
        out[key] = pr ? prFields(ctx, repo, pr, f.children) : null;
        break;
      }
      default: out[key] = null;
    }
  }
  return out;
}
function selectFields(type: string, obj: Record<string, unknown>, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    out[key] = obj[f.name] ?? null;
  }
  void type;
  return out;
}
function issueFields(ctx: Ctx, repo: Repo, issue: IssueRec, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    switch (f.name) {
      case 'id': out[key] = issueGid(ctx, repo, issue); break;
      case 'number': out[key] = issue.number; break;
      case 'title': out[key] = issue.title; break;
      case 'state': out[key] = issue.state.toUpperCase(); break;
      case 'body': out[key] = issue.body; break;
      default: out[key] = null;
    }
  }
  return out;
}
function prFields(ctx: Ctx, repo: Repo, pr: PullRec, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.args)) args[k] = resolveValue(v, {});
    switch (f.name) {
      case 'id': out[key] = prGid(ctx, repo, pr); break;
      case 'number': out[key] = pr.number; break;
      case 'title': out[key] = pr.title; break;
      case 'body': out[key] = pr.body; break;
      case 'state': out[key] = pr.merged ? 'MERGED' : pr.state.toUpperCase(); break;
      case 'merged': out[key] = pr.merged; break;
      case 'headRefName': out[key] = pr.headRef; break;
      case 'baseRefName': out[key] = pr.baseRef; break;
      case 'mergeable': out[key] = pr.merged ? 'UNKNOWN' : mergeConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const files = diffFiles(repo, pr.baseSha, pr.headSha).slice(0, first);
        const nodes = files.map((fl) => selectFields('PullRequestChangedFile', { path: fl.filename }, f.children[0]?.children ?? [{ alias: null, name: 'path', args: {}, children: [], fragmentType: null }]));
        out[key] = selectFields('PullRequestChangedFileConnection', { nodes }, f.children);
        break;
      }
      default: out[key] = null;
    }
  }
  return out;
}
function cursorOf(index: number): string { return Buffer.from(`cursor:${index}`).toString('base64'); }
function cursorIndex(cursor: string | null | undefined): number {
  if (!cursor) return -1;
  try {
    const dec = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(dec);
    return m ? Number.parseInt(m[1], 10) : -1;
  } catch { return -1; }
}
function issuesConnection(ctx: Ctx, repo: Repo, field: FieldNode, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy) {
    const dir = String(orderBy.direction ?? 'ASC').toUpperCase();
    list.sort((a, b) => (dir === 'DESC' ? b.number - a.number || b.seq - a.seq : a.number - b.number || a.seq - b.seq));
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterIdx = cursorIndex(args.after as string | null | undefined);
  const start = afterIdx + 1;
  const page = list.slice(start, start + first);
  const hasNext = start + page.length < list.length;
  const endCursor = page.length > 0 ? cursorOf(start + page.length - 1) : null;
  const out: Record<string, unknown> = {};
  for (const f of field.children) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') out[key] = page.map((i) => issueFields(ctx, repo, i, f.children));
    else if (f.name === 'pageInfo') out[key] = selectFields('PageInfo', { hasNextPage: hasNext, endCursor }, f.children);
    else if (f.name === 'totalCount') out[key] = list.length;
  }
  return out;
}
function prsConnection(ctx: Ctx, repo: Repo, field: FieldNode, args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
  const page = [...repo.pulls].sort((a, b) => a.number - b.number).slice(0, first);
  const out: Record<string, unknown> = {};
  for (const f of field.children) {
    const key = f.alias ?? f.name;
    if (f.name === 'nodes') out[key] = page.map((p) => prFields(ctx, repo, p, f.children));
    else if (f.name === 'pageInfo') out[key] = selectFields('PageInfo', { hasNextPage: false, endCursor: null }, f.children);
    else if (f.name === 'totalCount') out[key] = repo.pulls.length;
  }
  return out;
}
function typeFields(name: string, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.alias ?? f.name;
    if (f.name === 'name') out[key] = name;
    else if (f.name === 'fields') out[key] = (FIELDS[name] ?? []).map((n) => ({ name: n }));
    else if (f.name === 'enumValues') out[key] = (ENUM_VALUES[name] ?? []).map((n) => ({ name: n }));
    else if (f.name === 'kind') out[key] = ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
    else out[key] = null;
  }
  return out;
}

function executeOp(ctx: Ctx, op: OpDef, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  validateFields(rootType, op.fields);
  const data: Record<string, unknown> = {};
  for (const f of op.fields) {
    const key = f.alias ?? f.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.args)) args[k] = resolveValue(v, variables);
    if (op.kind === 'query') {
      switch (f.name) {
        case 'viewer': data[key] = selectFields('User', { login: ctx.viewer, id: 1000 }, f.children); break;
        case 'repository': {
          const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
          data[key] = repo ? repoFields(ctx, repo, f.children, variables) : null;
          break;
        }
        case 'node': {
          const parsed = ctx.store.parseGid(String(args.id ?? ''));
          if (!parsed || parsed.kind !== 'R') { data[key] = null; break; }
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          if (!repo) { data[key] = null; break; }
          const node: Record<string, unknown> = {};
          for (const nf of f.children) {
            if (nf.name === '__fragment') {
              if (nf.fragmentType === 'Repository') Object.assign(node, repoFields(ctx, repo, nf.children, variables));
              continue;
            }
            if (nf.name === 'id') node[nf.alias ?? 'id'] = repoGid(ctx, repo);
          }
          data[key] = node;
          break;
        }
        case '__type': data[key] = typeFields(String(args.name ?? ''), f.children); break;
        default: data[key] = null;
      }
    } else {
      const input = (args.input ?? {}) as Record<string, unknown>;
      switch (f.name) {
        case 'createIssue': {
          const parsed = ctx.store.parseGid(String(input.repositoryId ?? ''));
          if (!parsed) err('Unknown repository id');
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          if (!repo) err('Unknown repository');
          const issue: IssueRec = { number: repo.nextIssue, title: String(input.title ?? ''), body: String(input.body ?? ''), state: 'open', labels: [], comments: [], seq: repo.seq };
          repo.nextIssue += 1; repo.seq += 1;
          repo.issues.push(issue);
          data[key] = selectFields('CreateIssuePayload', { issue: issueFields(ctx, repo, issue, f.children[0]?.children ?? []) }, f.children);
          break;
        }
        case 'closeIssue': {
          const parsed = ctx.store.parseGid(String(input.issueId ?? ''));
          if (!parsed) err('Unknown issue id');
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          const issue = repo?.issues.find((i) => i.number === parsed.n);
          if (!repo || !issue) err('Unknown issue');
          issue.state = 'closed';
          data[key] = selectFields('CloseIssuePayload', { issue: issueFields(ctx, repo, issue, f.children[0]?.children ?? []) }, f.children);
          break;
        }
        case 'createPullRequest': {
          const parsed = ctx.store.parseGid(String(input.repositoryId ?? ''));
          if (!parsed) err('Unknown repository id');
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          if (!repo) err('Unknown repository');
          const headRef = String(input.headRefName ?? '');
          const baseRef = String(input.baseRefName ?? '');
          const headTip = repo.refs.get(`refs/heads/${headRef}`);
          const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
          if (!headTip || !baseTip) err('Head or base branch does not exist');
          const pr: PullRec = {
            number: repo.nextPull, title: String(input.title ?? ''), body: String(input.body ?? ''),
            state: 'open', headRef, baseRef, headSha: headTip, baseSha: baseTip,
            merged: false, mergedAt: null, mergeCommitSha: null, baseTipAtCreate: baseTip, seq: repo.seq,
          };
          repo.nextPull += 1; repo.seq += 1;
          repo.pulls.push(pr);
          data[key] = selectFields('CreatePullRequestPayload', { pullRequest: prFields(ctx, repo, pr, f.children[0]?.children ?? []) }, f.children);
          break;
        }
        case 'mergePullRequest': {
          const parsed = ctx.store.parseGid(String(input.pullRequestId ?? ''));
          if (!parsed) err('Unknown pull request id');
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          const pr = repo?.pulls.find((p) => p.number === parsed.n);
          if (!repo || !pr) err('Unknown pull request');
          if (pr.merged || pr.state === 'closed') err('Pull request is already closed');
          const sha = squashMerge(ctx.store, repo, pr);
          if (sha === null) err('Merge conflict');
          data[key] = selectFields('MergePullRequestPayload', { pullRequest: prFields(ctx, repo, pr, f.children[0]?.children ?? []) }, f.children);
          break;
        }
        case 'addComment': {
          const parsed = ctx.store.parseGid(String(input.subjectId ?? ''));
          if (!parsed) err('Unknown subject id');
          const repo = ctx.store.getRepo(parsed.owner, parsed.name);
          const issue = repo?.issues.find((i) => i.number === parsed.n);
          if (!repo || !issue) err('Unknown issue');
          const comment = { id: repo.nextComment, body: String(input.body ?? '') };
          repo.nextComment += 1;
          issue.comments.push(comment);
          const node = selectFields('IssueComment', { id: commentGid(ctx, repo, issue, comment.id), body: comment.body }, f.children[0]?.children[0]?.children ?? []);
          data[key] = selectFields('AddCommentPayload', { commentEdge: { node } }, f.children);
          break;
        }
        default: data[key] = null;
      }
    }
  }
  return { data };
}

/** Handle one GraphQL request body (single operation or batch). */
export function handleGraphQL(store: Store, viewer: string, body: unknown): { status: number; body: unknown } {
  const ctx: Ctx = { store, viewer };
  const runOne = (item: unknown): Record<string, unknown> => {
    const obj = (item ?? {}) as Record<string, unknown>;
    const query = String(obj.query ?? '');
    const variables = (obj.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof obj.operationName === 'string' ? obj.operationName : null;
    if (!query || query.length > MAX_QUERY_LEN) return { data: null, errors: [{ message: 'Invalid query' }] };
    try {
      const ops = parseDocument(query);
      const op = operationName ? ops.find((o) => o.name === operationName) ?? ops[0] : ops[0];
      if (!op) return { data: null, errors: [{ message: 'No operation found' }] };
      return executeOp(ctx, op, variables);
    } catch (e) {
      if (e instanceof GqlError) return { data: null, errors: [{ message: e.message }] };
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL error' }] };
    }
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}

export { viewerLogin };
