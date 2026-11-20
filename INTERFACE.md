# INTERFACE.md — what session A built, exactly as session B must use it

Session B: read this file and do not guess. Everything below is already
implemented, tested and committed on branch `rebuild2-20261120`. Your job is
GraphQL v4 (`/api/graphql`) and MCP (`/mcp`) plus the final wiring in `app.ts`.
Do not change the behaviour of `store.ts`, `git.ts` or `rest.ts` except to fix
a bug the tests expose; if you must, say so in your report.

## Files (repo root)

- `main.ts` — entry lifecycle only: bind port 0, POST `$MAKEFUN_ENV_URL/register`
  `{"port": N}`, poll GET `$MAKEFUN_ENV_URL/done` until `{"done": true}`, exit 0.
  Do not touch.
- `app.ts` — `createApp(): Server`. HTTP plumbing + routing. See "Wiring" below.
- `store.ts` — in-memory state. `Store`, `Repo`, object helpers.
- `git.ts` — git smart HTTP. `handleGit(store, req): GitResponse`.
- `rest.ts` — REST v3. `handleRest(store, opts, req): RestResponse`.
- `package.json` — `{"type": "module", "scripts": {"start": "node --experimental-strip-types main.ts"}}`.
  Run with Node 22: `node --experimental-strip-types main.ts` (also works on Node 24).
- `tsconfig.json` — strict, `allowImportingTsExtensions`, `include: ["*.ts"]`.

## store.ts — exports

```ts
export const ZERO_OID: string;                 // 40 zeroes
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export function isOid(value: string): boolean;
export function hashObject(type: string, data: Buffer): string; // sha1("<type> <len>\0"+data)
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer; }
export interface CommitInfo { tree: string; parents: string[]; message: string; }
export function parseCommit(data: Buffer): CommitInfo;
export interface TreeEntry { mode: string; name: string; oid: string; }
export function parseTree(data: Buffer): TreeEntry[];
export interface TagInfo { object: string; type: string; tag: string; message: string; }
export function parseTag(data: Buffer): TagInfo;
export function trialTimestampSec(): number;    // MAKEFUN_TRIAL_NOW, else constant 1763000000
export function forgeIdentity(): { name: string; email: string }; // forge <forge@example.invalid>
export interface Issue { number; title; body; state: 'open'|'closed'; labels: string[]; comments: {id; body}[]; }
export interface Pull { number; title; body; state: 'open'|'closed'; headRef; baseRef; headSha; baseSha;
                        merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; }
```

```ts
export class Repo {
  name: string; description: string; isPrivate: boolean;
  defaultBranch: string;               // always 'main'
  owner: string | null;                // bound lazily, see resolveRepo
  objects: Map<string, GitObject>;     // raw bytes, exactly as pushed
  refs: Map<string, string>;           // 'refs/heads/main' -> commit oid, etc.
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextCommentId: number;
  readonly seq: number;                // creation order, used for pagination
  putObject(type, data): string;                     // returns oid, stores if absent
  putObjectChecked(type, data, oid): boolean;        // false when hash mismatches
  getObject(oid): GitObject | undefined;
  hasObject(oid): boolean;
  refTip(ref): string | undefined;
  reachable(roots: Iterable<string>): Set<string>;  // commit->tree+parents, tree->entries (no gitlinks), tag->target
  isAncestor(ancestor, descendant): boolean;         // parent walk, equal counts as ancestor
  peel(oid): string;                                // follow tag objects to a non-tag
  flattenTree(treeOid): Map<string, { oid; mode }>; // path -> blob entry
  writeTreeFromFiles(files: Map<string, string>): string; // path -> blob oid; returns root tree oid
  createCommit(treeOid, parents: string[], message): string;
  commitHistory(tip): { sha; message }[];           // newest first, parent walk
  lookupPath(treeOid, path): {kind:'file', oid, size} | {kind:'dir', oid, entries} | null;
}
export class Store {
  createRepo(name, description, isPrivate): Repo | null; // null when the name exists
  getRepo(name): Repo | undefined;
  deleteRepo(name): boolean;
  listRepos(): Repo[];                              // creation order
}
export function resolveRepo(store, owner, name): Repo | null;
```

`resolveRepo` is the ownership rule. A repo is created owner-less
(`owner === null`). The first request that addresses it by URL owner binds
`repo.owner` to that owner; any later request with a different owner gets
`null` (caller answers 404, never 403). The suite always reads its own repos
before any foreign-owner probe, so first-seen binding is correct. The token
itself (`MAKEFUN_SHOP_TOKEN`, `shpat_...`) is opaque and names no login.

Timestamps for server-authored commits use `trialTimestampSec()` — deterministic,
never `Date.now()`.

## git.ts — exports

```ts
export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface PktLine { kind: PktKind; data?: Buffer; }
export function pktLine(data: Buffer | string): Buffer;
export function pktFlush(): Buffer;                 // '0000'
export function pktDelim(): Buffer;                 // '0001'
export function decodePktLines(buf: Buffer): PktLine[]; // throws on bad header, length 3, >65520, truncation
export function applyDelta(base: Buffer, delta: Buffer): Buffer;
export function parsePack(buf: Buffer): Map<string, { type; data }>; // verifies header, trailer SHA-1,
    // every entry size and every object hash; throws on any corruption, never partial
export function writePack(objects: Iterable<{ type; data }>): Buffer; // plain pack v2, oid-sorted, no deltas
export interface GitRequest {
  method: string;
  action: 'info-refs' | 'upload-pack' | 'receive-pack';
  owner: string; repoName: string;
  service: string | null;        // ?service=git-upload-pack | git-receive-pack
  gitProtocolV2: boolean;        // header Git-Protocol: version=2
  body: Buffer;                  // raw request body (already size-capped by app.ts)
}
export interface GitResponse { status: number; contentType: string; body: Buffer; }
export function handleGit(store: Store, req: GitRequest): GitResponse;
```

Behaviour already implemented (do not re-derive, do not change):

- `info/refs`: preamble `# service=...` + flush, then the advertisement + flush.
  Upload-pack with `Git-Protocol: version=2` answers v2 (`version 2`, `ls-refs=unborn`,
  `fetch=shallow wait-for-done filter`, `object-format=sha1`, `agent=forge/1.0`).
  Otherwise v0. Receive-pack is always v0. Missing repo is 404 on both services.
- v0 advertisement: first ref line carries capabilities after NUL.
  Upload-pack caps: `side-band-64k ofs-delta thin-pack multi_ack_detailed shallow
  symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1`.
  Receive-pack caps: `report-status side-band-64k delete-refs ofs-delta agent=forge/1.0
  symref=HEAD:refs/heads/main`.
  Empty repo: one line, zero OID + `capabilities^{}` + caps. **No zero-OID HEAD line
  is ever advertised when the default branch does not exist.** Non-empty repo:
  `HEAD` line first (tip of `refs/heads/main`), then `refs/heads/*`, `refs/tags/*`,
  each annotated tag followed by its peeled `^{}` line.
- `ls-refs` (v2): `HEAD` is subject to prefix filtering — with a `ref-prefix`
  argument, `HEAD` is sent only when a prefix matches `HEAD` (e.g. no prefix at
  all). Prefix with no match answers only a flush. `peel` adds `peeled:<commit>`
  on annotated tags; `symref-target:refs/heads/main` is always on the HEAD line;
  `unborn` answers `unborn HEAD symref-target:refs/heads/main` when the default
  branch is missing (real git names the unborn line `HEAD`; that is how a clone
  learns the default branch of an empty repository).
- Fetch v2 sections: the `acknowledgments` section is sent ONLY while the client
  is still negotiating, i.e. while its request has no `done` line. Once `done`
  arrives the response goes straight to `shallow-info` (only when there are
  shallow/unshallow lines) and `packfile` (only when at least one object is
  sent; omitted entirely for nothing-new, and a bare flush when there is nothing
  at all). This matches real `git upload-pack` (verified against git 2.43) and
  the suite client tolerates a missing acknowledgments section.
  Fetch v0: `NAK`/`ACK` text lines, then `shallow`/`unshallow` lines, then
  sideband packets, then flush. No section names in v0.
- Object selection: `reachable(wants) - reachable(haves)`, with haves truncated
  at the client's shallow boundary. `deepen N`: commits up to N deep from each
  want; the depth-N commits are the new `shallow` boundary; old shallow commits
  inside the depth become `unshallow`. Thin packs are never sent: every pack is
  self-contained plain objects. Sideband band-1 packets carry at most 65515 data
  bytes each; no band 2/3 is sent.
- Receive-pack: commands parsed to the first flush, the rest is the raw pack
  (a pack is required for any create/update, even an empty one; delete-only
  sends none). Pack corrupt or hash mismatch → `unpack <detail>`, no ref
  changes. Per-ref fast-forward rules, applied independently: `ok` for the
  refs that move, `ng <ref> non-fast-forward` (exact string) for the ones that
  do not. Report is pkt-framed inside sideband band 1 and ends with an inner
  flush `0000`, then the outer stream flush. `unpack ok` is sent even when a
  ref is refused. Delete needs old == current tip; create needs old zero and a
  missing ref; update needs old == current tip and new a descendant of old.
- Malformed git input never crashes the server: 400, state untouched.

## rest.ts — exports

```ts
export interface RestOptions { token: string | null; }   // null disables auth (local dev only)
export interface RestRequest {
  method: string;
  path: string;                 // pathname under /api/v3, e.g. '/repos/o/r/issues'
  query: URLSearchParams;
  headers: Record<string, string | undefined>; // lower-cased keys
  body: Buffer;
  host: string;                 // for absolute pagination Link URLs
}
export interface RestResponse { status: number; body: string; headers: Record<string, string>; }
export function handleRest(store: Store, opts: RestOptions, req: RestRequest): RestResponse;
```

Behaviour already implemented:

- Every reply is JSON with a non-empty `X-GitHub-Request-Id` (`req-<counter>`).
  Unknown route → 404 `{"message"}`. Malformed JSON body → 400 `{"message"}`.
  No token (when `opts.token` is set) → 401 `{"message"}`. A repo under another
  owner → 404, never 403 (via `resolveRepo`).
- `GET /` → 200 + `X-OAuth-Scopes: repo, read:org`. `GET /meta` → 200
  `{"installed_version": "1.0.0"}`.
- `POST /user/repos` → 201 repo, duplicate name → 422. `GET /user/repos` →
  creation order, `per_page`/`page`, `Link: <abs url>; rel="next"` only when a
  next page exists.
- `GET/PATCH/DELETE /repos/{o}/{r}` → 200 / 200 / 204 (no body). PATCH updates
  `description`.
- `POST /repos/{o}/{r}/git/refs` → 201 `{ref, object:{sha}}`; bad ref/sha → 422.
- `GET /branches` → `[{name, commit:{sha}}]`. `GET /commits?sha=<branch|oid>` →
  `[{sha, commit:{message}}]` newest first; no `sha` means the default branch.
- `PUT /contents/{path}` → 201 create / 200 update / 409 stale sha. Creates real
  git objects (blob + tree + commit) on the target branch (or the default
  branch), so a git clone sees them. First PUT on an unborn repo creates the
  default branch. `GET /contents/{path}?ref=` → file object (base64, sha, byte
  size) or a directory array `[{type, name, path, sha}]`; missing → 404.
  `DELETE /contents/{path}` → 200 `{commit:{sha}}`, reads the DELETE body.
- `POST /labels` → 201 `{name, color}`. `POST /issues` → 201, unknown label →
  422 and no issue is created. Issue numbers start at 1 per repo, +1 each.
  `GET /issues?state=&sort=created&direction=&per_page=` (default state `open`).
  `GET /issues/{n}`, `PATCH /issues/{n}` (state open/closed, persists).
  `POST/GET /issues/{n}/comments` → 201 `{id, body}` / array, ids start at 1.
- `POST /pulls` → 201 with `head:{ref,sha}`, `base:{ref,sha}` as of creation.
  `GET /pulls/{n}`, `GET /pulls?state=` (default open only, `all` includes
  merged), `GET /pulls/{n}/files` → diff of recorded base sha vs head sha
  (`{filename, status, additions, deletions, changes}`).
  `PUT /pulls/{n}/merge` (`merge_method: squash`) → 200 `{merged:true, sha,
  message}`; writes one squash commit on the base branch (base tree + head's
  changes), sets `state: closed`, `merged: true`, `merged_at`, `merge_commit_sha`.
  Unknown PR → 404; already merged → 405; same file changed on both sides with
  different content since the PR branched off → 405.

## app.ts — wiring (your extension point)

`createApp()` builds one `Store`, reads `MAKEFUN_SHOP_TOKEN` once, and routes:

- `GET /healthz` → 200 `{"ok": true}` (no token).
- `/{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack` → `handleGit`.
  Anything else under `*.git` → 404 plain.
- `/api/v3` or `/api/v3/*` → `handleRest` with the path after the `/api/v3` prefix.
- Everything else → 404 JSON `{"message": "Not Found"}`.

Request bodies are capped at 64 MiB (over → 413 JSON). The same `Store`
instance is shared by git and REST, so a repo created over REST is pushable
over git and vice versa. **Session B: add `POST /api/graphql` and `POST /mcp`
in `app.ts` before the final 404, using the same `store` and the same token
rule (GraphQL unauthenticated → exactly 401; MCP without Authorization → 401).
Do not create a second store.**

## Security review applied (session A)

From `~/workspace/custom-skills/security-audit-skill/skills/security-audit/SKILL.md`
(guidance mode): every pushed object is re-hashed (SHA-1 recompute) before it
is stored; request bodies are capped at 64 MiB; a single inflated pack entry
is capped at 64 MiB; no `exec`/`eval`/filesystem access from any request
input; refs and object ids are validated against strict patterns before use;
all maps that take client-controlled keys are `Map`s (no prototype pollution
through plain objects); malformed input answers 4xx and never crashes the
process. Body parsing never throws out of a request handler.
