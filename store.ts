// In-memory store for one forge process: git objects, refs and REST resources.
// Every git object is kept as the exact raw bytes it arrived with, so a clone
// returns byte-identical objects. No filesystem, no exec, no network at runtime.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const MAX_BODY_BYTES = 64 * 1024 * 1024; // 64 MiB: request bodies and inflated pack entries

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 object id: sha1("<type> <decimal length>\0" + data), lowercase hex. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) throw new Error('corrupt tree: no space');
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree: no oid');
    entries.push({
      mode: data.subarray(i, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    i = nul + 21;
  }
  return entries;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

/** Seconds for server-authored commits: the trial's fixed now, else a constant. */
export function trialTimestampSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw) / 1000;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  return 1763000000;
}

/** Author/committer line for commits the forge itself writes (REST contents, merges). */
export function forgeIdentity(): { name: string; email: string } {
  return { name: 'forge', email: 'forge@example.invalid' };
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: { id: number; body: string }[];
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export class Repo {
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  /** Owner login, bound lazily from the first request that names this repo. */
  owner: string | null = null;
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  readonly seq: number;

  constructor(name: string, description: string, isPrivate: boolean, seq: number) {
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.seq = seq;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (pack entries); verify the hash. */
  putObjectChecked(type: GitObjectType, data: Buffer, oid: string): boolean {
    if (hashObject(type, data) !== oid) return false;
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return true;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  refTip(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** Full closure of `roots`: commit -> tree + parents, tree -> entries (not gitlinks), tag -> target. */
  reachable(roots: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid) || !isOid(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        stack.push(info.tree, ...info.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** True when `ancestor` is reachable from `descendant` by following parents (or equal). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** Peel a tag object to its ultimate non-tag target (or the oid itself). */
  peel(oid: string): string {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.objects.get(current);
      if (obj === undefined || obj.type !== 'tag') return current;
      current = parseTag(obj.data).object;
    }
    return current;
  }

  /** Flat path -> {oid, mode} map for the tree at `treeOid`. */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Build (or rebuild) a tree from a flat path -> blob-oid map, writing every
   * intermediate tree object. Returns the root tree oid.
   */
  writeTreeFromFiles(files: Map<string, string>): string {
    // Group paths by directory; build bottom-up.
    const byDir = new Map<string, { files: { name: string; oid: string; mode: string }[]; subdirs: string[] }>();
    const ensure = (dir: string) => {
      let entry = byDir.get(dir);
      if (entry === undefined) {
        entry = { files: [], subdirs: [] };
        byDir.set(dir, entry);
      }
      return entry;
    };
    ensure('');
    const dirs = new Set<string>(['']);
    for (const path of files.keys()) {
      const parts = path.split('/');
      let dir = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        dir = dir === '' ? parts[i] : `${dir}/${parts[i]}`;
        dirs.add(dir);
      }
    }
    for (const dir of dirs) {
      ensure(dir);
      const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      if (dir !== '') ensure(parent).subdirs.push(dir.split('/').pop() as string);
    }
    for (const [path, oid] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      ensure(dir).files.push({ name, oid, mode: '100644' });
    }
    // Git tree sort: byte order on names, directories compared as if suffixed with '/'.
    const sortKey = (name: string, isDir: boolean): string => (isDir ? `${name}/` : name);
    const treeOids = new Map<string, string>();
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const sortedDirs = [...dirs].sort((a, b) => depthOf(b) - depthOf(a));
    for (const dir of sortedDirs) {
      const entry = byDir.get(dir) as { files: { name: string; oid: string; mode: string }[]; subdirs: string[] };
      const parts: { name: string; mode: string; oid: string; isDir: boolean }[] = [];
      for (const file of entry.files) parts.push({ name: file.name, mode: file.mode, oid: file.oid, isDir: false });
      for (const sub of entry.subdirs) {
        const subPath = dir === '' ? sub : `${dir}/${sub}`;
        const subOid = treeOids.get(subPath);
        if (subOid !== undefined) parts.push({ name: sub, mode: '40000', oid: subOid, isDir: true });
      }
      parts.sort((a, b) => (sortKey(a.name, a.isDir) < sortKey(b.name, b.isDir) ? -1 : 1));
      const bufParts: Buffer[] = [];
      for (const part of parts) {
        bufParts.push(Buffer.from(`${part.mode} ${part.name}\0`, 'utf8'));
        bufParts.push(Buffer.from(part.oid, 'hex'));
      }
      treeOids.set(dir, this.putObject('tree', Buffer.concat(bufParts)));
    }
    return treeOids.get('') as string;
  }

  /** Create a commit object; returns its oid. Timestamp is deterministic. */
  createCommit(treeOid: string, parents: string[], message: string): string {
    const { name, email } = forgeIdentity();
    const ts = trialTimestampSec();
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${name} <${email}> ${ts} +0000`);
    lines.push(`committer ${name} <${email}> ${ts} +0000`);
    const body = `${lines.join('\n')}\n\n${message}${message.endsWith('\n') ? '' : '\n'}`;
    return this.putObject('commit', Buffer.from(body, 'utf8'));
  }

  /** Walk parents from `tip`, newest first. Stops at unknown objects. */
  commitHistory(tip: string | undefined): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const stack: string[] = tip === undefined ? [] : [tip];
    while (stack.length > 0) {
      const oid = stack.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      // GitHub's API strips the single trailing newline of a commit message.
      const message = info.message.endsWith('\n') ? info.message.slice(0, -1) : info.message;
      out.push({ sha: oid, message });
      stack.push(...info.parents);
    }
    return out;
  }

  /** Resolve a path inside a tree: file, directory listing, or null. */
  lookupPath(
    treeOid: string,
    path: string,
  ): { kind: 'file'; oid: string; size: number } | { kind: 'dir'; oid: string; entries: { name: string; path: string; oid: string; kind: 'file' | 'dir' }[] } | null {
    const parts = path === '' ? [] : path.split('/');
    let currentOid = treeOid;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const obj = this.objects.get(currentOid);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[depth]);
      if (entry === undefined) return null;
      if (depth === parts.length - 1) {
        if (entry.mode === '40000') {
          return { kind: 'dir', oid: entry.oid, entries: listDir(this, entry.oid, path) };
        }
        const blob = this.objects.get(entry.oid);
        if (blob === undefined) return null;
        return { kind: 'file', oid: entry.oid, size: blob.data.length };
      }
      if (entry.mode !== '40000') return null;
      currentOid = entry.oid;
    }
    return { kind: 'dir', oid: currentOid, entries: listDir(this, currentOid, '') };
  }
}

function listDir(
  repo: Repo,
  treeOid: string,
  prefix: string,
): { name: string; path: string; oid: string; kind: 'file' | 'dir' }[] {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    oid: entry.oid,
    kind: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
}

/** One process-wide store: repositories keyed by name (names are unique per token). */
export class Store {
  private readonly reposByName = new Map<string, Repo>();
  private seq = 0;

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.reposByName.has(name)) return null;
    this.seq += 1;
    const repo = new Repo(name, description, isPrivate, this.seq);
    this.reposByName.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.reposByName.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.reposByName.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.seq - b.seq);
  }
}

/**
 * Resolve a repo by URL owner + name. The owner is bound lazily: the first
 * request that names a repo fixes its owner (the suite always reads its own
 * repos before any foreign-owner probe), and any other owner then gets 404.
 */
export function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.getRepo(name);
  if (repo === undefined) return null;
  if (repo.owner === null) repo.owner = owner;
  if (repo.owner !== owner) return null;
  return repo;
}
