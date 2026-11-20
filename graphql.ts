// GitHub GraphQL v4, minimal hand-written parser + executor for exactly the
// documents gh and github-mcp-server send (kit checks-graphql.ts).
// Node stdlib only. Unknown fields answer HTTP 200 with an errors array.

import {
  VIEWER,
  globalId,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  diffFiles,
  filesAt,
  mergeConflicts,
  mergePullRecord,
} from './rest.ts';

// -------------------------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '"' ? '"' : e === '\\' ? '\\' : e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j += 1;
      const raw = src.slice(i, j);
      tokens.push(raw.includes('.') ? { kind: 'float', value: Number.parseFloat(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------- AST

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean | null;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  alias?: string;
  name: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selection?: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; type: string }>;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('unexpected end of document');
    this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }
  expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t?.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const n = this.peek();
    if (n?.kind === 'name') name = this.next().value;
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        this.expectPunct('$');
        const vname = this.expectName();
        this.expectPunct(':');
        let type = '';
        while (!(this.peek()?.kind === 'punct' && (this.peek()!.value === ')' || this.peek()!.value === ','))) {
          const tt = this.next();
          type += tt.kind === 'name' ? tt.value : tt.value;
        }
        variables.push({ name: vname, type });
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  parseSelection(): SelectionNode {
    const t = this.peek();
    if (t?.kind === 'spread') {
      this.next();
      const n = this.peek();
      if (n?.kind === 'name' && n.value === 'on') {
        this.next();
        const type = this.expectName();
        const selection = this.parseSelectionSet();
        return { kind: 'fragment', type, selection };
      }
      throw new Error('named fragments are not supported');
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      args = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const aname = this.expectName();
        this.expectPunct(':');
        args.push({ name: aname, value: this.parseValue() });
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) {
        items.push(this.parseValue());
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const fname = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fname, value: this.parseValue() });
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value');
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name!];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((i) => evalValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = evalValue(f.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args ?? []) out[a.name] = evalValue(a.value, variables);
  return out;
}

// -------------------------------------------------------------------------------- schema tables

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PR_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const SEARCH_ENUM = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'CODE'];

// -------------------------------------------------------------------------------- executor

class GraphQLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLError';
  }
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function issueId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}
function repoId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}
function prId(repo: Repo, pr: PullRequest): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}
function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveIssueField(repo: Repo, issue: Issue, field: FieldNode, ctx: Ctx): unknown {
  switch (field.name) {
    case 'id':
      return issueId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'state':
      return issueState(issue);
    case 'body':
      return issue.body;
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Issue".`);
  }
}

function resolvePrField(repo: Repo, pr: PullRequest, field: FieldNode, ctx: Ctx): unknown {
  switch (field.name) {
    case 'id':
      return prId(repo, pr);
    case 'number':
      return pr.number;
    case 'state':
      return prState(pr);
    case 'merged':
      return pr.merged;
    case 'headRefName':
      return pr.head;
    case 'baseRefName':
      return pr.base;
    case 'mergeable':
      return mergeConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
    case 'files': {
      const args = argMap(field, ctx.variables);
      const first = typeof args['first'] === 'number' ? args['first'] : 10;
      const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
      const headTip = repo.refs.get(`refs/heads/${pr.head}`);
      const files = diffFiles(repo, filesAt(repo, baseTip), filesAt(repo, headTip));
      return resolveConnection(
        files.map((f) => ({ path: f.filename })),
        first,
        field.selection ?? [],
        ctx,
        (item, f) => {
          if (f.name === 'path') return item.path;
          throw new GraphQLError(`Cannot query field "${f.name}" on type "PullRequestChangedFile".`);
        },
      );
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequest".`);
  }
}

function resolveConnection<T>(
  items: T[],
  first: number,
  selection: SelectionNode[],
  ctx: Ctx,
  resolveItem: (item: T, field: FieldNode) => unknown,
): Record<string, unknown> {
  const nodes = items.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    if (f.name === 'nodes') {
      out[f.alias ?? f.name] = nodes.map((item) => {
        const obj: Record<string, unknown> = {};
        for (const sub of f.selection ?? []) {
          if (sub.kind !== 'field') continue;
          obj[sub.field.alias ?? sub.field.name] = resolveItem(item, sub.field);
        }
        return obj;
      });
    } else if (f.name === 'pageInfo') {
      const hasNext = items.length > first;
      out[f.alias ?? f.name] = resolvePageInfo(items, first, nodes, f.selection ?? []);
    } else {
      throw new GraphQLError(`Cannot query field "${f.name}" on type "Connection".`);
    }
  }
  return out;
}

function resolvePageInfo<T>(items: T[], first: number, nodes: T[], selection: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind !== 'field') continue;
    if (sel.field.name === 'hasNextPage') out[sel.field.alias ?? 'hasNextPage'] = items.length > first;
    else if (sel.field.name === 'endCursor') {
      const last = nodes[nodes.length - 1];
      out[sel.field.alias ?? 'endCursor'] = last !== undefined ? cursorFor(last) : null;
    } else {
      throw new GraphQLError(`Cannot query field "${sel.field.name}" on type "PageInfo".`);
    }
  }
  return out;
}

function cursorFor(item: unknown): string {
  const n = (item as { number?: number }).number;
  return Buffer.from(`cursor:${n ?? 0}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

function resolveIssuesConnection(repo: Repo, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args = argMap(field, ctx.variables);
  const first = typeof args['first'] === 'number' ? args['first'] : 10;
  const states = Array.isArray(args['states']) ? (args['states'] as string[]) : null;
  const orderBy = (args['orderBy'] as { field?: string; direction?: string } | undefined) ?? {};
  const after = cursorNumber(args['after']);
  let list = [...repo.issues.values()];
  if (states) {
    const want = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const dir = (orderBy.direction ?? 'DESC').toUpperCase();
  list.sort((a, b) => (dir === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  if (after !== null) {
    list = dir === 'ASC' ? list.filter((i) => i.number > after) : list.filter((i) => i.number < after);
  }
  const nodes = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const sel of field.selection ?? []) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    if (f.name === 'nodes') {
      out[f.alias ?? f.name] = nodes.map((issue) => {
        const obj: Record<string, unknown> = {};
        for (const sub of f.selection ?? []) {
          if (sub.kind !== 'field') continue;
          obj[sub.field.alias ?? sub.field.name] = resolveIssueField(repo, issue, sub.field, ctx);
        }
        return obj;
      });
    } else if (f.name === 'pageInfo') {
      out[f.alias ?? f.name] = resolvePageInfo(list, first, nodes, f.selection ?? []);
    } else {
      throw new GraphQLError(`Cannot query field "${f.name}" on type "IssueConnection".`);
    }
  }
  return out;
}

function resolvePrsConnection(repo: Repo, field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const args = argMap(field, ctx.variables);
  const first = typeof args['first'] === 'number' ? args['first'] : 10;
  const list = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const nodes = list.slice(0, first);
  const out: Record<string, unknown> = {};
  for (const sel of field.selection ?? []) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    if (f.name === 'nodes') {
      out[f.alias ?? f.name] = nodes.map((pr) => {
        const obj: Record<string, unknown> = {};
        for (const sub of f.selection ?? []) {
          if (sub.kind !== 'field') continue;
          obj[sub.field.alias ?? sub.field.name] = resolvePrField(repo, pr, sub.field, ctx);
        }
        return obj;
      });
    } else if (f.name === 'pageInfo') {
      out[f.alias ?? f.name] = resolvePageInfo(list, first, nodes, f.selection ?? []);
    } else {
      throw new GraphQLError(`Cannot query field "${f.name}" on type "PullRequestConnection".`);
    }
  }
  return out;
}

function resolveRepoField(repo: Repo, field: FieldNode, ctx: Ctx): unknown {
  const args = argMap(field, ctx.variables);
  switch (field.name) {
    case 'id':
      return repoId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'owner': {
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'login') out[sub.field.alias ?? 'login'] = repo.owner;
        else throw new GraphQLError(`Cannot query field "${sub.field.name}" on type "User".`);
      }
      return out;
    }
    case 'defaultBranchRef': {
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'name') out[sub.field.alias ?? 'name'] = repo.defaultBranch;
        else throw new GraphQLError(`Cannot query field "${sub.field.name}" on type "Ref".`);
      }
      return out;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'issue': {
      const issue = repo.issues.get(args['number'] as number);
      if (!issue) return null;
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        out[sub.field.alias ?? sub.field.name] = resolveIssueField(repo, issue, sub.field, ctx);
      }
      return out;
    }
    case 'issues':
      return resolveIssuesConnection(repo, field, ctx);
    case 'pullRequests':
      return resolvePrsConnection(repo, field, ctx);
    case 'pullRequest': {
      const pr = repo.pulls.get(args['number'] as number);
      if (!pr) return null;
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        out[sub.field.alias ?? sub.field.name] = resolvePrField(repo, pr, sub.field, ctx);
      }
      return out;
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`);
  }
}

function resolveTypeField(field: FieldNode, ctx: Ctx): unknown {
  const args = argMap(field, ctx.variables);
  const name = args['name'] as string;
  const out: Record<string, unknown> = {};
  for (const sub of field.selection ?? []) {
    if (sub.kind !== 'field') continue;
    const f = sub.field;
    if (f.name === 'fields') {
      let names: string[] = [];
      if (name === 'Issue') names = ISSUE_FIELDS;
      else if (name === 'PullRequest') names = PR_FIELDS;
      else if (name === 'Repository') names = REPO_FIELDS;
      out[f.alias ?? 'fields'] = names.map((n) => ({ name: n }));
    } else if (f.name === 'enumValues') {
      const names = name === 'SearchType' ? SEARCH_ENUM : [];
      out[f.alias ?? 'enumValues'] = names.map((n) => ({ name: n }));
    } else if (f.name === 'name') {
      out[f.alias ?? 'name'] = name;
    } else {
      throw new GraphQLError(`Cannot query field "${f.name}" on type "__Type".`);
    }
  }
  return out;
}

function findRepoById(store: Store, id: string): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Repository') return undefined;
  const [owner, name] = parsed.key.split('/');
  if (!owner || !name) return undefined;
  return store.getRepo(owner, name);
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'Issue') return undefined;
  const m = parsed.key.match(/^(.+)\/([^/]+)#(\d+)$/);
  if (!m) return undefined;
  const repo = store.getRepo(m[1]!, m[2]!);
  const issue = repo?.issues.get(Number.parseInt(m[3]!, 10));
  if (!repo || !issue) return undefined;
  return { repo, issue };
}

function findPrById(store: Store, id: string): { repo: Repo; pr: PullRequest } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== 'PullRequest') return undefined;
  const m = parsed.key.match(/^(.+)\/([^/]+)#(\d+)$/);
  if (!m) return undefined;
  const repo = store.getRepo(m[1]!, m[2]!);
  const pr = repo?.pulls.get(Number.parseInt(m[3]!, 10));
  if (!repo || !pr) return undefined;
  return { repo, pr };
}

function resolveQueryField(store: Store, field: FieldNode, ctx: Ctx): unknown {
  const args = argMap(field, ctx.variables);
  switch (field.name) {
    case 'viewer': {
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'login') out[sub.field.alias ?? 'login'] = VIEWER.login;
        else throw new GraphQLError(`Cannot query field "${sub.field.name}" on type "User".`);
      }
      return out;
    }
    case 'repository': {
      const repo = store.getRepo(String(args['owner'] ?? ''), String(args['name'] ?? ''));
      if (!repo) return null;
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        out[sub.field.alias ?? sub.field.name] = resolveRepoField(repo, sub.field, ctx);
      }
      return out;
    }
    case 'node': {
      const id = String(args['id'] ?? '');
      const repo = findRepoById(store, id);
      if (!repo) return null;
      const out: Record<string, unknown> = { id };
      for (const sel of field.selection ?? []) {
        if (sel.kind === 'fragment') {
          if (sel.type === 'Repository') {
            for (const sub of sel.selection) {
              if (sub.kind !== 'field') continue;
              if (sub.field.name === 'name') out[sub.field.alias ?? 'name'] = repo.name;
              else if (sub.field.name === 'nameWithOwner') out[sub.field.alias ?? 'nameWithOwner'] = `${repo.owner}/${repo.name}`;
              else throw new GraphQLError(`Cannot query field "${sub.field.name}" on type "Repository".`);
            }
          }
          continue;
        }
        if (sel.kind !== 'field') continue;
        if (sel.field.name === 'id') out[sel.field.alias ?? 'id'] = id;
        else throw new GraphQLError(`Cannot query field "${sel.field.name}" on type "Node".`);
      }
      return out;
    }
    case '__type':
      return resolveTypeField(field, ctx);
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }
}

function resolveMutationField(store: Store, field: FieldNode, ctx: Ctx): unknown {
  const args = argMap(field, ctx.variables);
  const input = (args['input'] as Record<string, unknown> | undefined) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoById(store, String(input['repositoryId'] ?? ''));
      if (!repo) throw new GraphQLError('Repository not found.');
      const issue = createIssueRecord(repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'issue') {
          const io: Record<string, unknown> = {};
          for (const s2 of sub.field.selection ?? []) {
            if (s2.kind !== 'field') continue;
            io[s2.field.alias ?? s2.field.name] = resolveIssueField(repo, issue, s2.field, ctx);
          }
          out[sub.field.alias ?? 'issue'] = io;
        }
      }
      return out;
    }
    case 'closeIssue': {
      const found = findIssueById(store, String(input['issueId'] ?? ''));
      if (!found) throw new GraphQLError('Issue not found.');
      found.issue.state = 'closed';
      found.issue.updatedAt = new Date().toISOString();
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'issue') {
          const io: Record<string, unknown> = {};
          for (const s2 of sub.field.selection ?? []) {
            if (s2.kind !== 'field') continue;
            io[s2.field.alias ?? s2.field.name] = resolveIssueField(found.repo, found.issue, s2.field, ctx);
          }
          out[sub.field.alias ?? 'issue'] = io;
        }
      }
      return out;
    }
    case 'createPullRequest': {
      const repo = findRepoById(store, String(input['repositoryId'] ?? ''));
      if (!repo) throw new GraphQLError('Repository not found.');
      const pr = createPullRecord(repo, String(input['headRefName'] ?? ''), String(input['baseRefName'] ?? ''), String(input['title'] ?? ''), String(input['body'] ?? ''));
      if (!pr) throw new GraphQLError('head or base branch does not exist.');
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'pullRequest') {
          const po: Record<string, unknown> = {};
          for (const s2 of sub.field.selection ?? []) {
            if (s2.kind !== 'field') continue;
            po[s2.field.alias ?? s2.field.name] = resolvePrField(repo, pr, s2.field, ctx);
          }
          out[sub.field.alias ?? 'pullRequest'] = po;
        }
      }
      return out;
    }
    case 'mergePullRequest': {
      const found = findPrById(store, String(input['pullRequestId'] ?? ''));
      if (!found) throw new GraphQLError('Pull request not found.');
      const result = mergePullRecord(store, found.repo, found.pr);
      if (result.status !== 200) throw new GraphQLError(result.message);
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'pullRequest') {
          const po: Record<string, unknown> = {};
          for (const s2 of sub.field.selection ?? []) {
            if (s2.kind !== 'field') continue;
            po[s2.field.alias ?? s2.field.name] = resolvePrField(found.repo, found.pr, s2.field, ctx);
          }
          out[sub.field.alias ?? 'pullRequest'] = po;
        }
      }
      return out;
    }
    case 'addComment': {
      const found = findIssueById(store, String(input['subjectId'] ?? ''));
      if (!found) throw new GraphQLError('Issue not found.');
      const text = String(input['body'] ?? '');
      found.repo.commentSeq += 1;
      const cid = found.repo.commentSeq;
      found.issue.comments.push({ id: String(cid), body: text, createdSeq: cid, createdAt: new Date().toISOString() });
      const commentId = globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${cid}`);
      const out: Record<string, unknown> = {};
      for (const sub of field.selection ?? []) {
        if (sub.kind !== 'field') continue;
        if (sub.field.name === 'commentEdge') {
          const node: Record<string, unknown> = {};
          for (const s2 of sub.field.selection ?? []) {
            if (s2.kind !== 'field') continue;
            if (s2.field.name === 'node') {
              const cn: Record<string, unknown> = {};
              for (const s3 of s2.field.selection ?? []) {
                if (s3.kind !== 'field') continue;
                if (s3.field.name === 'id') cn[s3.field.alias ?? 'id'] = commentId;
                else if (s3.field.name === 'body') cn[s3.field.alias ?? 'body'] = text;
                else throw new GraphQLError(`Cannot query field "${s3.field.name}" on type "IssueComment".`);
              }
              node[s2.field.alias ?? 'node'] = cn;
            }
          }
          out[sub.field.alias ?? 'commentEdge'] = node;
        }
      }
      return out;
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>, operationName?: string): Record<string, unknown> {
  if (operationName && op.name && op.name !== operationName) {
    throw new GraphQLError(`Unknown operation named "${operationName}".`);
  }
  const ctx: Ctx = { store, variables };
  const data: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind !== 'field') continue;
    const f = sel.field;
    const key = f.alias ?? f.name;
    data[key] = op.kind === 'mutation' ? resolveMutationField(store, f, ctx) : resolveQueryField(store, f, ctx);
  }
  return { data };
}

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Handle one POST /api/graphql body (already parsed JSON or a parse failure). */
export function handleGraphQL(store: Store, rawBody: Buffer, authorized: boolean): GraphQLResult {
  if (!authorized) {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (single: unknown): Record<string, unknown> => {
    const obj = (single ?? {}) as Record<string, unknown>;
    const query = typeof obj['query'] === 'string' ? obj['query'] : '';
    const variables = (obj['variables'] ?? {}) as Record<string, unknown>;
    const operationName = typeof obj['operationName'] === 'string' ? obj['operationName'] : undefined;
    try {
      const ops = new Parser(tokenize(query)).parseDocument();
      const op = operationName ? ops.find((o) => o.name === operationName) ?? ops[0] : ops[0];
      if (!op) throw new GraphQLError('No operation found.');
      return executeOperation(store, op, variables, operationName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: null, errors: [{ message }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
