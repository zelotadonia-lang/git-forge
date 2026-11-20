// Shared domain operations for the GraphQL and MCP surfaces: opaque global
// ids, the viewer login, pull-request file diffs and squash merges. REST keeps
// its own copies in rest.ts; this module duplicates the small merge logic
// rather than touching rest.ts.

import { parseCommit, trialTimestampSec, type Issue, type Pull, type Repo, type Store } from './store.ts';

/** Opaque global ids: a type prefix plus base64url of "<kind>:<repo seq>:<n>". */
export function repoGlobalId(repo: Repo): string {
  return `R_${Buffer.from(`R:${repo.seq}`, 'utf8').toString('base64url')}`;
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${Buffer.from(`I:${repo.seq}:${issue.number}`, 'utf8').toString('base64url')}`;
}

export function pullGlobalId(repo: Repo, pr: Pull): string {
  return `PR_${Buffer.from(`PR:${repo.seq}:${pr.number}`, 'utf8').toString('base64url')}`;
}

export function commentGlobalId(repo: Repo, commentId: number): string {
  return `IC_${Buffer.from(`C:${repo.seq}:${commentId}`, 'utf8').toString('base64url')}`;
}

export type DecodedId =
  | { kind: 'repo'; repoSeq: number }
  | { kind: 'issue'; repoSeq: number; number: number }
  | { kind: 'pull'; repoSeq: number; number: number }
  | { kind: 'comment'; repoSeq: number; number: number }
  | null;

/** Decode a global id produced above; null for anything else. */
export function decodeGlobalId(id: unknown): DecodedId {
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) return null;
  const underscore = id.indexOf('_');
  if (underscore <= 0) return null;
  const prefix = id.slice(0, underscore);
  if (prefix !== 'R' && prefix !== 'I' && prefix !== 'PR' && prefix !== 'IC') return null;
  let plain: string;
  try {
    plain = Buffer.from(id.slice(underscore + 1), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = plain.split(':');
  const kind = parts[0];
  const repoSeq = Number(parts[1]);
  if (!Number.isInteger(repoSeq) || repoSeq <= 0) return null;
  if (kind === 'R' && prefix === 'R' && parts.length === 2) return { kind: 'repo', repoSeq };
  const number = Number(parts[2]);
  if (!Number.isInteger(number) || number <= 0) return null;
  if (kind === 'I' && prefix === 'I' && parts.length === 3) return { kind: 'issue', repoSeq, number };
  if (kind === 'PR' && prefix === 'PR' && parts.length === 3) return { kind: 'pull', repoSeq, number };
  if (kind === 'C' && prefix === 'IC' && parts.length === 3) return { kind: 'comment', repoSeq, number };
  return null;
}

export function repoBySeq(store: Store, seq: number): Repo | undefined {
  return store.listRepos().find((repo) => repo.seq === seq);
}

export function findRepoById(store: Store, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  return repoBySeq(store, decoded.repoSeq) ?? null;
}

export function findIssueById(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue') return null;
  const repo = repoBySeq(store, decoded.repoSeq);
  if (repo === undefined) return null;
  const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
  return issue === undefined ? null : { repo, issue };
}

export function findPullById(store: Store, id: unknown): { repo: Repo; pr: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pull') return null;
  const repo = repoBySeq(store, decoded.repoSeq);
  if (repo === undefined) return null;
  const pr = repo.pulls.find((candidate) => candidate.number === decoded.number);
  return pr === undefined ? null : { repo, pr };
}

/**
 * The login the bearer token names. The token itself is opaque, so the login
 * is the owner bound to the earliest-created repository: the suite creates
 * the viewer's repositories before any other owner's, and every surface
 * binds owners through resolveRepo. Null when no repository has an owner yet.
 */
export function viewerLogin(store: Store): string | null {
  for (const repo of store.listRepos()) {
    if (repo.owner !== null) return repo.owner;
  }
  return null;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
}

/** Flat file diff between two commit tips (recorded shas or live tips). */
export function diffFileChanges(repo: Repo, baseTip: string, headTip: string): FileChange[] {
  const flat = (tip: string): Map<string, { oid: string; mode: string }> => {
    const obj = repo.getObject(tip);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return repo.flattenTree(parseCommit(obj.data).tree);
  };
  const base = flat(baseTip);
  const head = flat(headTip);
  const out: FileChange[] = [];
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) out.push({ path, status: 'removed' });
    else if (b === undefined && h !== undefined) out.push({ path, status: 'added' });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) out.push({ path, status: 'modified' });
  }
  return out;
}

/** Paths changed on a pull request, added or modified only (as REST /files). */
export function pullRequestFiles(repo: Repo, pr: Pull): { path: string }[] {
  return diffFileChanges(repo, pr.baseSha, pr.headSha)
    .filter((file) => file.status !== 'removed')
    .map((file) => ({ path: file.path }));
}

function isoNow(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? Number.NaN : Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(trialTimestampSec() * 1000).toISOString();
}

/** True when the pull request cannot merge cleanly (same file changed both sides). */
export function pullRequestConflicts(repo: Repo, pr: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (baseTip === undefined || headTip === undefined) return false;
  const baseChanged = diffFileChanges(repo, pr.baseSha, baseTip);
  const headChanged = diffFileChanges(repo, pr.baseSha, headTip);
  const baseByPath = new Map(baseChanged.map((file) => [file.path, file]));
  const flatAt = (tip: string): Map<string, { oid: string; mode: string }> => {
    const obj = repo.getObject(tip);
    if (obj === undefined || obj.type !== 'commit') return new Map();
    return repo.flattenTree(parseCommit(obj.data).tree);
  };
  const baseNow = flatAt(baseTip);
  const headNow = flatAt(headTip);
  for (const file of headChanged) {
    if (!baseByPath.has(file.path)) continue;
    if (baseNow.get(file.path)?.oid !== headNow.get(file.path)?.oid) return true;
  }
  return false;
}

/** Mergeable state for a pull request, from the live branch tips. */
export function mergeableState(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (repo.refs.get(`refs/heads/${pr.baseRef}`) === undefined) return 'UNKNOWN';
  if (repo.refs.get(`refs/heads/${pr.headRef}`) === undefined) return 'UNKNOWN';
  return pullRequestConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: string };

/**
 * Squash-merge a pull request onto its base branch: one commit carrying the
 * head's changes over the base tip. Mirrors the REST merge in rest.ts.
 */
export function mergePullRequest(repo: Repo, pr: Pull): MergeResult {
  if (pr.state !== 'open' || pr.merged) return { ok: false, reason: 'Pull request is not open' };
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pr.headRef}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'Branch not found' };
  if (pullRequestConflicts(repo, pr)) return { ok: false, reason: 'Merge conflict' };
  const baseFlat = new Map<string, string>();
  const baseObj = repo.getObject(baseTip);
  if (baseObj !== undefined && baseObj.type === 'commit') {
    for (const [path, entry] of repo.flattenTree(parseCommit(baseObj.data).tree)) baseFlat.set(path, entry.oid);
  }
  const headFlat = new Map<string, string>();
  const headObj = repo.getObject(headTip);
  if (headObj !== undefined && headObj.type === 'commit') {
    for (const [path, entry] of repo.flattenTree(parseCommit(headObj.data).tree)) headFlat.set(path, entry.oid);
  }
  for (const file of diffFileChanges(repo, pr.baseSha, headTip)) {
    if (file.status === 'removed') baseFlat.delete(file.path);
    else {
      const oid = headFlat.get(file.path);
      if (oid !== undefined) baseFlat.set(file.path, oid);
    }
  }
  const treeOid = repo.writeTreeFromFiles(baseFlat);
  const mergeSha = repo.createCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${pr.headRef}`);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoNow();
  pr.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha };
}
