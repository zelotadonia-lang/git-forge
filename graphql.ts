// GraphQL v4 API (POST /api/graphql), hand-written parser and executor over
// the same in-memory store as REST and git. Node standard library only: no
// GraphQL framework. Only the subset of the language the suite sends is
// supported (see specs/graphql.md); anything else is a GraphQL error, never a
// crash. Security: the query text is capped, selection depth and node count
// are capped, and no input reaches exec/eval/the filesystem.

import {
  commentGlobalId,
  decodeGlobalId,
  findIssueById,
  findPullById,
  findRepoById,
  issueGlobalId,
  mergePullRequest,
  mergeableState,
  pullGlobalId,
  pullRequestFiles,
  repoBySeq,
  repoGlobalId,
  viewerLogin,
  type DecodedId,
} from './forge.ts';
import { resolveRepo, type Issue, type Pull, type Repo, type Store } from './store.ts';

export const MAX_QUERY_CHARS = 1_000_000;
const MAX_TOKENS = 100_000;
const MAX_DEPTH = 32;
const MAX_SELECTIONS = 5_000;

class GQLError extends Error {
  locations?: { line: number; column: number }[];
  constructor(message: string, line?: number, column?: number) {
    super(message);
    if (line !== undefined && column !== undefined) this.locations = [{ line, column }];
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function lex(source: string): Token[] {
  if (source.length > MAX_QUERY_CHARS) {
    throw new GQLError('Query is too large.');
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',' || ch === '﻿') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
      advance(3);
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startColumn });
      advance();
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or a normal string.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new GQLError('Unterminated block string.', startLine, startColumn);
        const raw = source.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""'), line: startLine, column: startColumn });
        advance(end + 3 - i);
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\n') throw new GQLError('Unterminated string.', startLine, startColumn);
        if (c === '\\') {
          const esc = source[j + 1] as string;
          const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GQLError('Invalid unicode escape in string.', startLine, startColumn);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else if (simple[esc] !== undefined) {
            value += simple[esc] as string;
            j += 2;
          } else {
            throw new GQLError(`Invalid escape sequence \\${esc} in string.`, startLine, startColumn);
          }
          continue;
        }
        value += c;
        j += 1;
      }
      if (!closed) throw new GQLError('Unterminated string.', startLine, startColumn);
      tokens.push({ kind: 'string', value, line: startLine, column: startColumn });
      advance(j + 1 - i);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: raw, line: startLine, column: startColumn });
      advance(j - i);
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j), line: startLine, column: startColumn });
      advance(j - i);
      continue;
    }
    throw new GQLError(`Unexpected character ${JSON.stringify(ch)}.`, startLine, startColumn);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  if (tokens.length > MAX_TOKENS) throw new GQLError('Query has too many tokens.');
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST)
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[] | null;
  line: number;
  column: number;
}

interface SpreadNode {
  kind: 'spread';
  name: string;
  line: number;
  column: number;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
  line: number;
  column: number;
}

type SelectionNode = FieldNode | SpreadNode | InlineFragmentNode;

interface VariableDefinition {
  name: string;
  baseType: string;
  nonNull: boolean;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private selectionCount = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GQLError(`Expected "${value}", found ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}.`, token.line, token.column);
    }
    return token;
  }

  private expectName(what = 'a name'): Token {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new GQLError(`Expected ${what}, found ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}.`, token.line, token.column);
    }
    return token;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variables: [],
          selections: this.parseSelectionSet(1),
        });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragmentDefinition();
        fragments.set(fragment.name, fragment);
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        operations.push(this.parseOperation());
        continue;
      }
      throw new GQLError(`Unexpected ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}.`, token.line, token.column);
    }
    if (operations.length === 0) throw new GQLError('Document contains no operation.');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const keyword = this.next();
    const operation = keyword.value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    let variables: VariableDefinition[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') variables = this.parseVariableDefinitions();
    this.skipDirectives();
    const selections = this.parseSelectionSet(1);
    return { kind: 'operation', operation, name, variables, selections };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const out: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name').value;
      this.expectPunct(':');
      const { baseType, nonNull } = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      this.skipDirectives();
      out.push({ name, baseType, nonNull, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): { baseType: string; nonNull: boolean } {
    let baseType: string;
    let nonNull = false;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      baseType = inner.baseType;
      this.expectPunct(']');
    } else {
      baseType = this.expectName('a type name').value;
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      nonNull = true;
    }
    return { baseType, nonNull };
  }

  private parseFragmentDefinition(): FragmentNode {
    this.next(); // 'fragment'
    const name = this.expectName('a fragment name').value;
    const on = this.expectName('the keyword "on"');
    if (on.value !== 'on') throw new GQLError('Expected the keyword "on" in a fragment definition.', on.line, on.column);
    const typeCondition = this.expectName('a type name').value;
    this.skipDirectives();
    return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet(1) };
  }

  private parseSelectionSet(depth: number): SelectionNode[] {
    if (depth > MAX_DEPTH) throw new GQLError('Query is nested too deeply.');
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GQLError('Unterminated selection set.');
      selections.push(this.parseSelection(depth));
      this.selectionCount += 1;
      if (this.selectionCount > MAX_SELECTIONS) throw new GQLError('Query selects too many fields.');
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(depth: number): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const startLine = token.line;
      const startColumn = token.column;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name').value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet(depth + 1), line: startLine, column: startColumn };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name, line: startLine, column: startColumn };
      }
      throw new GQLError('Expected a fragment name or "on" after "...".', token.line, token.column);
    }
    return this.parseField(depth);
  }

  private parseField(depth: number): FieldNode {
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName('a field name').value;
    }
    let args = new Map<string, ValueNode>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet(depth + 1);
    return { kind: 'field', alias, name, args, selections, line: first.line, column: first.column };
  }

  private parseArguments(): Map<string, ValueNode> {
    this.expectPunct('(');
    const args = new Map<string, ValueNode>();
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      if (this.peek().kind === 'eof') throw new GQLError('Unterminated argument list.');
      const name = this.expectName('an argument name').value;
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName('a variable name').value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new GQLError('Unterminated list value.');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new GQLError('Unterminated object value.');
        const name = this.expectName('a field name').value;
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GQLError(`Unexpected value ${JSON.stringify(token.value)}.`, token.line, token.column);
  }
}

function parseDocument(source: string): Document {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema (the surface the suite introspects and queries)
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'object' | 'enum';
  fields?: string[];
  values?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'object', fields: ['viewer', 'repository', 'node', '__type'] },
  User: { kind: 'object', fields: ['login'] },
  Repository: {
    kind: 'object',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Ref: { kind: 'object', fields: ['name'] },
  Issue: { kind: 'object', fields: ['id', 'number', 'title', 'state', 'body'] },
  IssueConnection: { kind: 'object', fields: ['nodes', 'pageInfo'] },
  PullRequestConnection: { kind: 'object', fields: ['nodes', 'pageInfo'] },
  PageInfo: { kind: 'object', fields: ['hasNextPage', 'endCursor'] },
  PullRequest: {
    kind: 'object',
    fields: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  },
  PullRequestChangedFileConnection: { kind: 'object', fields: ['nodes', 'pageInfo'] },
  PullRequestChangedFile: { kind: 'object', fields: ['path'] },
  Mutation: { kind: 'object', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  CreateIssuePayload: { kind: 'object', fields: ['issue'] },
  CloseIssuePayload: { kind: 'object', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'object', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'object', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'object', fields: ['commentEdge'] },
  IssueCommentEdge: { kind: 'object', fields: ['node'] },
  IssueComment: { kind: 'object', fields: ['id', 'body'] },
  __Type: { kind: 'object', fields: ['name', 'kind', 'fields', 'enumValues'] },
  __Field: { kind: 'object', fields: ['name'] },
  __EnumValue: { kind: 'object', fields: ['name'] },
  IssueState: { kind: 'enum', values: ['OPEN', 'CLOSED'] },
  IssueOrderField: { kind: 'enum', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'enum', values: ['ASC', 'DESC'] },
  MergeableState: { kind: 'enum', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'enum', values: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { kind: 'enum', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'enum', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'enum', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
};

/** Declared return type per field (a trailing ! or [...] is stripped at use). */
const FIELD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User!', repository: 'Repository', node: 'Node', __type: '__Type' },
  User: { login: 'String!' },
  Repository: {
    id: 'ID!', databaseId: 'Int!', name: 'String!', nameWithOwner: 'String!', owner: 'User!',
    defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission!', hasIssuesEnabled: 'Boolean!',
    issue: 'Issue', issues: 'IssueConnection!', pullRequests: 'PullRequestConnection!', pullRequest: 'PullRequest',
  },
  Ref: { name: 'String!' },
  Issue: { id: 'ID!', number: 'Int!', title: 'String!', state: 'IssueState!', body: 'String' },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo!' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo!' },
  PageInfo: { hasNextPage: 'Boolean!', endCursor: 'String' },
  PullRequest: {
    id: 'ID!', number: 'Int!', state: 'PullRequestState!', merged: 'Boolean!',
    headRefName: 'String!', baseRefName: 'String!', mergeable: 'MergeableState',
    files: 'PullRequestChangedFileConnection!', title: 'String!', body: 'String',
  },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo!' },
  PullRequestChangedFile: { path: 'String!' },
  Mutation: {
    createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID!', body: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String!' },
  __EnumValue: { name: 'String!' },
};

const SCALAR_TYPES = new Set(['String', 'Int', 'Float', 'ID', 'Boolean']);
const ENUM_TYPES = new Set(Object.entries(SCHEMA).filter(([, def]) => def.kind === 'enum').map(([name]) => name));

// ---------------------------------------------------------------------------
// Values: wrapped store objects carry their GraphQL type in __type.
// ---------------------------------------------------------------------------

type Wrapped = { __type: string; [key: string]: unknown };

function wrapRepo(repo: Repo): Wrapped {
  return { __type: 'Repository', repo };
}

function wrapIssue(repo: Repo, issue: Issue): Wrapped {
  return { __type: 'Issue', repo, issue };
}

function wrapPull(repo: Repo, pr: Pull): Wrapped {
  return { __type: 'PullRequest', repo, pr };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`c:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): number {
  let plain: string;
  try {
    plain = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    throw new GQLError('Invalid cursor.');
  }
  const match = /^c:(\d+)$/.exec(plain);
  if (match === null) throw new GQLError('Invalid cursor.');
  return Number.parseInt(match[1] as string, 10);
}

function reqString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new GQLError(`${what} must be a non-empty string.`);
  return value;
}

function optInt(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new GQLError(`Argument "${what}" must be a non-negative integer.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  definedVariables: Set<string>;
  fragments: Map<string, FragmentNode>;
}

function resolveValue(node: ValueNode, ctx: ExecContext): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!ctx.definedVariables.has(node.name)) throw new GQLError(`Variable "$${node.name}" is not defined by an operation.`);
      if (!(node.name in ctx.variables)) throw new GQLError(`Variable "$${node.name}" was not provided.`);
      return ctx.variables[node.name];
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, ctx));
    case 'object': {
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of node.fields) {
        // Guard against prototype pollution through a crafted object literal.
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[key] = resolveValue(child, ctx);
      }
      return out;
    }
  }
}

function resolveArgs(args: Map<string, ValueNode>, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, node] of args) out[name] = resolveValue(node, ctx);
  return out;
}

type Resolver = (parent: Wrapped, args: Record<string, unknown>, ctx: ExecContext) => unknown;

function buildIssuesConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  let list = repo.issues.slice();
  if (args.states !== undefined && args.states !== null) {
    if (!Array.isArray(args.states)) throw new GQLError('Argument "states" must be a list.');
    const wanted = new Set<string>();
    for (const state of args.states) {
      if (state !== 'OPEN' && state !== 'CLOSED') throw new GQLError(`Value "${String(state)}" is not a valid IssueState.`);
      wanted.add(state as string);
    }
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  let direction = 'DESC';
  if (args.orderBy !== undefined && args.orderBy !== null) {
    if (!isRecord(args.orderBy)) throw new GQLError('Argument "orderBy" must be an object.');
    const field = args.orderBy.field;
    const dir = args.orderBy.direction;
    if (field !== 'CREATED_AT' && field !== 'UPDATED_AT' && field !== 'COMMENTS') {
      throw new GQLError(`Value "${String(field)}" is not a valid IssueOrderField.`);
    }
    if (dir !== 'ASC' && dir !== 'DESC') throw new GQLError(`Value "${String(dir)}" is not a valid OrderDirection.`);
    direction = dir as string;
  }
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    if (typeof args.after !== 'string') throw new GQLError('Argument "after" must be a string.');
    start = decodeCursor(args.after) + 1;
  }
  const first = optInt(args.first, 'first');
  const end = first === null ? list.length : Math.min(list.length, start + first);
  const page = list.slice(start, end);
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => wrapIssue(repo, issue)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: end < list.length,
      endCursor: page.length > 0 ? encodeCursor(start + page.length - 1) : null,
    },
  };
}

function buildPullsConnection(repo: Repo, args: Record<string, unknown>): Wrapped {
  const sorted = repo.pulls.slice().sort((a, b) => b.number - a.number);
  const first = optInt(args.first, 'first');
  const page = first === null ? sorted : sorted.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pr) => wrapPull(repo, pr)),
    pageInfo: { __type: 'PageInfo', hasNextPage: first !== null && sorted.length > first, endCursor: null },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (_parent, _args, ctx) => ({ __type: 'User', login: viewerLogin(ctx.store) ?? '' }),
    repository: (_parent, args, ctx) => {
      const owner = reqString(args.owner, 'Argument "owner"');
      const name = reqString(args.name, 'Argument "name"');
      const repo = resolveRepo(ctx.store, owner, name);
      return repo === null ? null : wrapRepo(repo);
    },
    node: (_parent, args, ctx) => {
      const decoded: DecodedId = decodeGlobalId(args.id);
      if (decoded === null) return null;
      if (decoded.kind === 'repo') {
        const repo = repoBySeq(ctx.store, decoded.repoSeq);
        return repo === undefined ? null : wrapRepo(repo);
      }
      if (decoded.kind === 'issue') {
        const repo = repoBySeq(ctx.store, decoded.repoSeq);
        const issue = repo?.issues.find((candidate) => candidate.number === decoded.number);
        return repo === undefined || issue === undefined ? null : wrapIssue(repo, issue);
      }
      if (decoded.kind === 'pull') {
        const repo = repoBySeq(ctx.store, decoded.repoSeq);
        const pr = repo?.pulls.find((candidate) => candidate.number === decoded.number);
        return repo === undefined || pr === undefined ? null : wrapPull(repo, pr);
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = reqString(args.name, 'Argument "name"');
      return SCHEMA[name] === undefined ? null : { __type: '__Type', name };
    },
  },
  User: {
    login: (parent) => parent.login ?? '',
  },
  Repository: {
    id: (parent) => repoGlobalId(parent.repo as Repo),
    databaseId: (parent) => (parent.repo as Repo).seq,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => {
      const repo = parent.repo as Repo;
      return `${repo.owner ?? ''}/${repo.name}`;
    },
    owner: (parent) => ({ __type: 'User', login: (parent.repo as Repo).owner ?? '' }),
    defaultBranchRef: (parent) => {
      const repo = parent.repo as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __type: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args) => {
      const number = optInt(args.number, 'number');
      if (number === null) throw new GQLError('Argument "number" is required.');
      const repo = parent.repo as Repo;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      return issue === undefined ? null : wrapIssue(repo, issue);
    },
    issues: (parent, args) => buildIssuesConnection(parent.repo as Repo, args),
    pullRequests: (parent, args) => buildPullsConnection(parent.repo as Repo, args),
    pullRequest: (parent, args) => {
      const number = optInt(args.number, 'number');
      if (number === null) throw new GQLError('Argument "number" is required.');
      const repo = parent.repo as Repo;
      const pr = repo.pulls.find((candidate) => candidate.number === number);
      return pr === undefined ? null : wrapPull(repo, pr);
    },
  },
  Ref: {
    name: (parent) => parent.name ?? '',
  },
  Issue: {
    id: (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent.issue as Issue).body,
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage ?? false,
    endCursor: (parent) => parent.endCursor ?? null,
  },
  PullRequest: {
    id: (parent) => pullGlobalId(parent.repo as Repo, parent.pr as Pull),
    number: (parent) => (parent.pr as Pull).number,
    state: (parent) => {
      const pr = parent.pr as Pull;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (parent) => (parent.pr as Pull).merged,
    headRefName: (parent) => (parent.pr as Pull).headRef,
    baseRefName: (parent) => (parent.pr as Pull).baseRef,
    mergeable: (parent) => mergeableState(parent.repo as Repo, parent.pr as Pull),
    files: (parent, args) => {
      const repo = parent.repo as Repo;
      const pr = parent.pr as Pull;
      const first = optInt(args.first, 'first');
      const all = pullRequestFiles(repo, pr).map((file) => ({ __type: 'PullRequestChangedFile', path: file.path }));
      const page = first === null ? all : all.slice(0, first);
      return {
        __type: 'PullRequestChangedFileConnection',
        nodes: page,
        pageInfo: { __type: 'PageInfo', hasNextPage: first !== null && all.length > first, endCursor: null },
      };
    },
    title: (parent) => (parent.pr as Pull).title,
    body: (parent) => (parent.pr as Pull).body,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes ?? [],
    pageInfo: (parent) => parent.pageInfo ?? null,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path ?? '',
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      if (!isRecord(args.input)) throw new GQLError('Argument "input" is required.');
      const input = args.input;
      const repo = findRepoById(ctx.store, input.repositoryId);
      if (repo === null) throw new GQLError('Repository not found for the given repositoryId.');
      const title = reqString(input.title, 'input.title');
      const body = typeof input.body === 'string' ? input.body : '';
      const issue: Issue = { number: repo.nextIssue, title, body, state: 'open', labels: [], comments: [] };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return { __type: 'CreateIssuePayload', issue: wrapIssue(repo, issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      if (!isRecord(args.input)) throw new GQLError('Argument "input" is required.');
      const found = findIssueById(ctx.store, args.input.issueId);
      if (found === null) throw new GQLError('Issue not found for the given issueId.');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      if (!isRecord(args.input)) throw new GQLError('Argument "input" is required.');
      const input = args.input;
      const repo = findRepoById(ctx.store, input.repositoryId);
      if (repo === null) throw new GQLError('Repository not found for the given repositoryId.');
      const baseRef = reqString(input.baseRefName, 'input.baseRefName');
      const headRef = reqString(input.headRefName, 'input.headRefName');
      const title = reqString(input.title, 'input.title');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined) throw new GQLError('head or base branch not found');
      const pr: Pull = {
        number: repo.nextPull,
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef,
        baseRef,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.nextPull += 1;
      repo.pulls.push(pr);
      return { __type: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pr) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      if (!isRecord(args.input)) throw new GQLError('Argument "input" is required.');
      const input = args.input;
      const method = input.mergeMethod;
      if (method !== undefined && method !== null && method !== 'MERGE' && method !== 'SQUASH' && method !== 'REBASE') {
        throw new GQLError(`Value "${String(method)}" is not a valid PullRequestMergeMethod.`);
      }
      const found = findPullById(ctx.store, input.pullRequestId);
      if (found === null) throw new GQLError('Pull request not found for the given pullRequestId.');
      const result = mergePullRequest(found.repo, found.pr);
      if (!result.ok) throw new GQLError(result.reason);
      return { __type: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, found.pr) };
    },
    addComment: (_parent, args, ctx) => {
      if (!isRecord(args.input)) throw new GQLError('Argument "input" is required.');
      const input = args.input;
      const found = findIssueById(ctx.store, input.subjectId);
      if (found === null) throw new GQLError('Issue not found for the given subjectId.');
      const body = reqString(input.body, 'input.body');
      const comment = { id: found.repo.nextCommentId, body };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: commentGlobalId(found.repo, comment.id), body },
        },
      };
    },
  },
  CreateIssuePayload: { issue: (parent) => parent.issue ?? null },
  CloseIssuePayload: { issue: (parent) => parent.issue ?? null },
  CreatePullRequestPayload: { pullRequest: (parent) => parent.pullRequest ?? null },
  MergePullRequestPayload: { pullRequest: (parent) => parent.pullRequest ?? null },
  AddCommentPayload: { commentEdge: (parent) => parent.commentEdge ?? null },
  IssueCommentEdge: { node: (parent) => parent.node ?? null },
  IssueComment: {
    id: (parent) => parent.id ?? '',
    body: (parent) => parent.body ?? '',
  },
  __Type: {
    name: (parent) => parent.name ?? '',
    kind: (parent) => (SCHEMA[parent.name as string]?.kind === 'enum' ? 'ENUM' : 'OBJECT'),
    fields: (parent) => {
      const def = SCHEMA[parent.name as string];
      if (def === undefined || def.kind !== 'object' || def.fields === undefined) return null;
      return def.fields.map((name) => ({ __type: '__Field', name }));
    },
    enumValues: (parent) => {
      const def = SCHEMA[parent.name as string];
      if (def === undefined || def.kind !== 'enum' || def.values === undefined) return null;
      return def.values.map((name) => ({ __type: '__EnumValue', name }));
    },
  },
  __Field: { name: (parent) => parent.name ?? '' },
  __EnumValue: { name: (parent) => parent.name ?? '' },
};

function baseTypeOf(declared: string): string {
  return declared.replace(/[!\[\]]/g, '');
}

function completeValue(declared: string, value: unknown, selections: SelectionNode[] | null, ctx: ExecContext, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  const base = baseTypeOf(declared);
  const isList = declared.includes('[');
  if (isList) {
    if (!Array.isArray(value)) throw new GQLError('Expected a list value.', field.line, field.column);
    return value.map((item) => completeSingle(base, item, selections, ctx, field));
  }
  return completeSingle(base, value, selections, ctx, field);
}

function completeSingle(base: string, value: unknown, selections: SelectionNode[] | null, ctx: ExecContext, field: FieldNode): unknown {
  if (SCALAR_TYPES.has(base) || ENUM_TYPES.has(base)) {
    if (selections !== null) throw new GQLError(`Field "${field.name}" of scalar type must not have sub-selections.`, field.line, field.column);
    return value;
  }
  if (value === null || value === undefined) return null;
  if (selections === null) throw new GQLError(`Field "${field.name}" of type "${base}" must have a selection of subfields.`, field.line, field.column);
  const wrapped = value as Wrapped;
  const runtimeType = typeof wrapped.__type === 'string' ? wrapped.__type : base;
  return executeSelectionSet(runtimeType, wrapped, selections, ctx);
}

function executeSelectionSet(typeName: string, parent: Wrapped, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[responseKey] = typeName;
        continue;
      }
      const declared = FIELD_TYPE[typeName]?.[selection.name];
      if (declared === undefined) {
        throw new GQLError(`Cannot query field "${selection.name}" on type "${typeName}".`, selection.line, selection.column);
      }
      const resolver = RESOLVERS[typeName]?.[selection.name];
      if (resolver === undefined) {
        throw new GQLError(`Cannot query field "${selection.name}" on type "${typeName}".`, selection.line, selection.column);
      }
      const args = resolveArgs(selection.args, ctx);
      const value = resolver(parent, args, ctx);
      out[responseKey] = completeValue(declared, value, selection.selections, ctx, selection);
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(typeName, parent, selection.selections, ctx));
      }
      continue;
    }
    const fragment = ctx.fragments.get(selection.name);
    if (fragment === undefined) throw new GQLError(`Unknown fragment "${selection.name}".`, selection.line, selection.column);
    if (fragment.typeCondition === typeName) {
      Object.assign(out, executeSelectionSet(typeName, parent, fragment.selections, ctx));
    }
  }
  return out;
}

function executeOperation(store: Store, document: Document, operationName: unknown, rawVariables: unknown): Record<string, unknown> {
  let operation: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) throw new GQLError(`Unknown operation named "${operationName}".`);
  } else if (document.operations.length === 1) {
    operation = document.operations[0];
  } else {
    throw new GQLError('Must provide operation name when there are multiple operations.');
  }
  if ((operation as OperationNode).operation === 'subscription') throw new GQLError('Subscriptions are not supported.');
  if (!isRecord(rawVariables) && rawVariables !== undefined && rawVariables !== null) {
    throw new GQLError('Variables must be an object.');
  }
  const provided = (isRecord(rawVariables) ? rawVariables : {}) as Record<string, unknown>;
  const variables: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const definedVariables = new Set<string>();
  for (const def of (operation as OperationNode).variables) {
    definedVariables.add(def.name);
    if (def.name in provided) {
      variables[def.name] = provided[def.name];
    } else if (def.defaultValue !== null) {
      variables[def.name] = resolveValue(def.defaultValue, { store, variables, definedVariables, fragments: document.fragments });
    } else if (def.nonNull) {
      throw new GQLError(`Variable "$${def.name}" of required type "${def.baseType}!" was not provided.`);
    }
  }
  const ctx: ExecContext = { store, variables, definedVariables, fragments: document.fragments };
  const rootType = (operation as OperationNode).operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Wrapped = { __type: rootType };
  return executeSelectionSet(rootType, root, (operation as OperationNode).selections, ctx);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export interface GraphQLHttpRequest {
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface GraphQLHttpResponse {
  status: number;
  body: string;
}

function errorEnvelope(err: unknown): Record<string, unknown> {
  if (err instanceof GQLError) {
    const entry: Record<string, unknown> = { message: err.message };
    if (err.locations !== undefined) entry.locations = err.locations;
    return { data: null, errors: [entry] };
  }
  return { data: null, errors: [{ message: 'Internal server error.' }] };
}

function runOne(store: Store, payload: unknown): Record<string, unknown> {
  try {
    if (!isRecord(payload)) return { data: null, errors: [{ message: 'Request body must be a JSON object with a "query" string.' }] };
    if (typeof payload.query !== 'string' || payload.query === '') {
      return { data: null, errors: [{ message: 'Request body must include a "query" string.' }] };
    }
    const document = parseDocument(payload.query);
    const data = executeOperation(store, document, payload.operationName, payload.variables);
    return { data };
  } catch (err) {
    return errorEnvelope(err);
  }
}

export function handleGraphQL(store: Store, token: string | null, req: GraphQLHttpRequest): GraphQLHttpResponse {
  if (token !== null && req.headers.authorization !== `Bearer ${token}`) {
    return { status: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, body: JSON.stringify({ message: 'Request body must be JSON' }) };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: JSON.stringify(parsed.map((item) => runOne(store, item))) };
  }
  return { status: 200, body: JSON.stringify(runOne(store, parsed)) };
}
