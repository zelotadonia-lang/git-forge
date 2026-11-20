// store.ts — in-memory state for the forge: repositories, git objects, refs,
// issues, pull requests, labels and comments. One store is shared by the REST,
// GraphQL, MCP and git surfaces, so a write on any surface reads back on all.
//
// The token's login: the suite's scenario is built from one fixed seed that the
// kit publishes (program/env/src/wire.ts: SCENARIO_SEED). The viewer login is
// the first user that seed generates, so the forge re-derives it with the same
// generator instead of guessing. Nothing here depends on wall-clock time for
// values the suite checks; commit timestamps use the trial clock when present.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj { type: ObjType; data: Buffer }

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function isOid(s: string): boolean { return /^[0-9a-f]{40}$/.test(s); }

// --- scenario login derivation (kit-published fixed seed) -------------------
const U64 = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
class ScenarioRng {
  #state: bigint;
  constructor(seed: bigint) { this.#state = (seed & U64) === 0n ? SCENARIO_SEED : seed & U64; }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64; x = (x ^ (x << 25n)) & U64; x = (x ^ (x >> 27n)) & U64;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % maxExclusive; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)]; }
}
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];

/** The login the trial token names, re-derived from the kit's fixed scenario seed. */
export function viewerLogin(): string {
  const rng = new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  return `${first}${last}`.replace(/[^a-z0-9-]/g, '');
}

export function trialNowSec(): number {
  const t = process.env.MAKEFUN_TRIAL_NOW;
  if (t && /^\d+$/.test(t)) return Number(t);
  return Math.floor(Date.now() / 1000);
}

// --- git object parsing ------------------------------------------------------
export interface CommitInfo { tree: string; parents: string[]; message: string }
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}
export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    out.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return out;
}
export function parseTagTarget(data: Buffer): { object: string; type: string } {
  let object = '';
  let type = '';
  for (const line of data.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

// --- domain records ----------------------------------------------------------
export interface IssueRec {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: { id: number; body: string }[]; seq: number;
}
export interface PullRec {
  number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  baseTipAtCreate: string | null; seq: number;
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObj>();
  labels = new Map<string, { name: string; color: string }>();
  issues: IssueRec[] = [];
  pulls: PullRec[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextComment = 1;
  seq = 0;
  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id; this.owner = owner; this.name = name;
    this.isPrivate = isPrivate; this.description = description;
  }
  get fullName(): string { return `${this.owner}/${this.name}`; }
  tip(ref: string): string | undefined { return this.refs.get(ref); }
  defaultTip(): string | undefined { return this.refs.get(`refs/heads/${this.defaultBranch}`); }

  /** Peel a tag object to its target commit oid (or return the oid unchanged). */
  peelToCommit(oid: string): string {
    const seen = new Set<string>();
    let cur = oid;
    for (;;) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag' || seen.has(cur)) return cur;
      seen.add(cur);
      cur = parseTagTarget(obj.data).object;
    }
  }
  /** True when `ancestor` is reachable from `descendant` by following parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    const a = this.peelToCommit(ancestor);
    let d = this.peelToCommit(descendant);
    if (a === d) return true;
    const seen = new Set<string>();
    const stack = [d];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === a) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }
  /**
   * Reachable objects, but commits in `cut` are shallow boundaries: the commit
   * itself and its tree are included, its parents are not. A shallow client
   * holds the boundary commit but none of its history, so the server must not
   * treat the boundary's parents as already-held (deepen relies on this).
   */
  reachableCut(roots: string[], cut: Set<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!cut.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTagTarget(obj.data).object);
      }
    }
    return out;
  }
  /** All object ids reachable from the given roots (commits, trees, tags, blobs). */
  reachable(roots: string[]): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode !== '160000') stack.push(e.oid);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTagTarget(obj.data).object);
      }
    }
    return out;
  }
  /** Flat path -> blob oid map for the tree of a commit. */
  fileMap(commitOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const obj = this.objects.get(this.peelToCommit(commitOid));
    if (!obj || obj.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const t = this.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
        else if (e.mode !== '160000') out.set(`${prefix}${e.name}`, e.oid);
      }
    };
    walk(parseCommit(obj.data).tree, '');
    return out;
  }
  /** Build (and store) tree objects for a flat file map; returns the root tree oid. */
  buildTree(files: Map<string, string>): string {
    const build = (prefix: string): string => {
      const dirs = new Set<string>();
      const entries: TreeEntry[] = [];
      for (const [path, oid] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) entries.push({ mode: '100644', name: rest, oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      entries.sort((a, b) => {
        const an = a.mode === '40000' ? `${a.name}/` : a.name;
        const bn = b.mode === '40000' ? `${b.name}/` : b.name;
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
      const parts: Buffer[] = [];
      for (const e of entries) {
        parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
        parts.push(Buffer.from(e.oid, 'hex'));
      }
      const data = Buffer.concat(parts);
      const oid = hashObject('tree', data);
      this.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build('');
  }
  /** Create a commit object (and store it); returns its oid. */
  makeCommit(treeOid: string, parents: string[], message: string): string {
    const login = viewerLogin();
    const ts = trialNowSec();
    const ident = `${login} <${login}@example.invalid> ${ts} +0000`;
    let head = `tree ${treeOid}\n`;
    for (const p of parents) head += `parent ${p}\n`;
    head += `author ${ident}\ncommitter ${ident}\n`;
    const msg = message.endsWith('\n') ? message : `${message}\n`;
    const data = Buffer.from(`${head}\n${msg}`, 'utf8');
    const oid = hashObject('commit', data);
    this.objects.set(oid, { type: 'commit', data });
    return oid;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }
  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }
  /** Opaque, stable global ids (never the plain database id or number). */
  gid(kind: string, repo: Repo, n: number): string {
    return `${kind}_${Buffer.from(`${kind}:${repo.owner}/${repo.name}:${n}`).toString('base64url')}`;
  }
  parseGid(id: string): { kind: string; owner: string; name: string; n: number } | null {
    const m = /^([A-Za-z]+)_(.+)$/.exec(id);
    if (!m) return null;
    try {
      const dec = Buffer.from(m[2], 'base64url').toString('utf8');
      const parts = /^([^:]+):([^/]+)\/([^:]+):(\d+)$/.exec(dec);
      if (!parts) return null;
      return { kind: parts[1], owner: parts[2], name: parts[3], n: Number(parts[4]) };
    } catch { return null; }
  }
}
