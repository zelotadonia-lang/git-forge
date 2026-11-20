// git smart HTTP: protocol v2 + v0 upload-pack, v0 receive-pack.
// Wire details mirror the suite's own client (kit program/env/src/git-client.ts):
// pkt-line framing, v2 capability advertisement, ls-refs/fetch sections,
// side-band-64k pack streams, report-status push reports.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The commit an annotated tag peels to, or null. */
function peelTarget(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  let target = parseTag(obj.data).object;
  for (;;) {
    const next = repo.objects.get(target);
    if (!next || next.type !== 'tag') return target;
    target = parseTag(next.data).object;
  }
}

// -------------------------------------------------------------------------------- advertisements

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:' + headTarget(repo) + ' side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0'
      : 'symref=HEAD:' + headTarget(repo) + ' report-status side-band-64k delete-refs ofs-delta quiet agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    if (head !== ZERO_OID) {
      parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    }
    for (const [i, ref] of refs.entries()) {
      // When the default branch does not exist yet, the first ref line carries the capabilities.
      const suffix = head === ZERO_OID && i === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      const peeled = peelTarget(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  name: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound();
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
    }
    return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  return notFound();
}

// -------------------------------------------------------------------------------- ls-refs (v2)

interface LsRefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (n: string): boolean => prefixes.length === 0 || prefixes.some((p) => n.startsWith(p));
  const out: LsRefLine[] = [];
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (keep('HEAD')) {
    if (headOid) out.push({ oid: headOid, name: 'HEAD', symrefTarget: symrefs ? head : undefined });
    else if (unborn) out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: head, unborn: true });
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    const line: LsRefLine = { oid: ref.oid, name: ref.name };
    if (peel) {
      const peeled = peelTarget(repo, ref.oid);
      if (peeled) line.peeled = peeled;
    }
    out.push(line);
  }
  const parts: Buffer[] = [];
  for (const r of out) {
    let text: string;
    if (r.unborn) text = `unborn ${r.name}${r.symrefTarget ? ` symref-target:${r.symrefTarget}` : ''}\n`;
    else {
      text = `${r.oid} ${r.name}`;
      if (r.symrefTarget) text += ` symref-target:${r.symrefTarget}`;
      if (r.peeled) text += ` peeled:${r.peeled}`;
      text += '\n';
    }
    parts.push(pktLine(text));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------- fetch planning

interface FetchPlan {
  /** objects to send, in deterministic order */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Commit generations from `wants` (0 = the wants themselves). */
function commitGenerations(
  repo: Repo,
  wants: string[],
  depth: number | null,
): Map<string, number> {
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  while (queue.length) {
    const [oid, g] = queue.shift()!;
    if (gen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      gen.set(oid, g);
      queue.push([target, g]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    gen.set(oid, g);
    if (depth !== null && g + 1 >= depth) continue;
    for (const p of parseCommit(obj.data).parents) queue.push([p, g + 1]);
  }
  return gen;
}

function planFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallow: string[],
  depth: number | null,
): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const haveReachable = new Set<string>();
  for (const h of haves) {
    try {
      for (const oid of collectReachable([h], lookup)) haveReachable.add(oid);
    } catch {
      // a have the server does not know: ignore it
    }
  }
  const gen = commitGenerations(repo, wants, depth);
  const included = new Set<string>(gen.keys());
  const maxGen = depth === null ? Infinity : depth - 1;
  const shallowOut: string[] = [];
  for (const [oid, g] of gen) {
    if (depth !== null && g === maxGen && repo.objects.get(oid)?.type === 'commit') shallowOut.push(oid);
  }
  const unshallow: string[] = [];
  for (const s of shallow) {
    const g = gen.get(s);
    if (g !== undefined && (depth === null || g < maxGen)) unshallow.push(s);
  }
  // Objects: every included commit/tag plus the tree closure of included commits,
  // minus anything the client already holds. Parents beyond the depth limit
  // contribute nothing: only each included commit's own tree is walked.
  const send = new Set<string>();
  const walkTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      send.add(oid);
      if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    }
  };
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    send.add(oid);
    if (obj.type === 'commit') walkTree(parseCommit(obj.data).tree);
    else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const targetObj = repo.objects.get(target);
      if (targetObj?.type === 'commit') {
        send.add(target);
        walkTree(parseCommit(targetObj.data).tree);
      } else if (targetObj) {
        send.add(target);
      }
    }
  }
  for (const oid of haveReachable) send.delete(oid);
  // Deterministic order: commits first (by generation), then trees/blobs sorted by oid.
  const ordered: GitObject[] = [];
  const byGen = [...send].sort((a, b) => {
    const ga = gen.get(a) ?? 99;
    const gb = gen.get(b) ?? 99;
    if (ga !== gb) return ga - gb;
    return a < b ? -1 : 1;
  });
  for (const oid of byGen) {
    const obj = repo.objects.get(oid);
    if (obj) ordered.push(obj);
  }
  return { objects: ordered, shallow: shallowOut.sort(), unshallow: unshallow.sort() };
}

/** Split a pack into sideband band-1 pkt-lines (pkt-line total max 65520 incl. header). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515; // 65516 payload - 1 band byte
  for (let off = 0; off < pack.length; off += MAX) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// -------------------------------------------------------------------------------- upload-pack v2

function parseV2Lines(body: Buffer): string[] {
  const lines: string[] = [];
  for (const p of decodePktLines(body)) {
    if (p.kind === 'data' && p.payload) lines.push(p.payload.toString('utf8').replace(/\n$/, ''));
    if (p.kind === 'flush') break;
  }
  return lines;
}

function handleUploadPackV2(repo: Repo, body: Buffer): GitResponse {
  const lines = parseV2Lines(body);
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length);
  if (command === 'ls-refs') {
    return { status: 200, contentType: UPLOAD_RESULT, body: handleLsRefs(repo, lines) };
  }
  if (command !== 'fetch') {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"unknown command"}\n', 'utf8') };
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  for (const w of wants) {
    if (!repo.objects.has(w)) {
      const parts = [pktLine('packfile\n'), pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object ${w} not found\n`, 'utf8')])), pktFlush()];
      return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    let anyAck = false;
    for (const h of haves) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        anyAck = true;
      }
    }
    if (!anyAck) parts.push(pktLine('NAK\n'));
    parts.push(pktLine('ready\n'));
    parts.push(pktDelim());
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktDelim());
  }
  if (plan.objects.length) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------- upload-pack v0

function handleUploadPackV0(repo: Repo, body: Buffer): GitResponse {
  // Two sections: wants (+ shallow/deepen) flush, then haves + done flush.
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data' || !p.payload) continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  for (const w of wants) {
    if (!repo.objects.has(w)) {
      const err = pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`object ${w} not found\n`, 'utf8')]));
      return { status: 200, contentType: UPLOAD_RESULT, body: err };
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  let anyAck = false;
  for (const h of haves) {
    if (repo.objects.has(h)) {
      parts.push(pktLine(`ACK ${h}\n`));
      anyAck = true;
    }
  }
  if (!anyAck) parts.push(pktLine('NAK\n'));
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.objects.length) {
    const pack = writePack(plan.objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: UPLOAD_RESULT, body: Buffer.concat(parts) };
}

export function handleUploadPack(
  store: Store,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound();
  try {
    if (gitProtocol === 'version=2') return handleUploadPackV2(repo, body);
    return handleUploadPackV0(repo, body);
  } catch (err) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: `bad request: ${err instanceof Error ? err.message : String(err)}` }) + '\n', 'utf8') };
  }
}

// -------------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound();
  const commands: PushCommand[] = [];
  let packStart = body.length;
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  {
    let off = 0;
    while (off + 4 <= body.length) {
      const len = Number.parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) break;
      if (len === 0) {
        packStart = off + 4;
        break;
      }
      const payload = body.subarray(off + 4, off + len).toString('utf8');
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      off += len;
    }
  }
  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes, (oid) => repo.objects.get(oid) ?? newObjects.get(oid));
      for (const [oid, obj] of parsed) newObjects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid) ?? newObjects.get(oid);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (!unpackOk) {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
  } else {
    // Stage: validate every command first, then apply the accepted ones.
    const accepted: PushCommand[] = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (cmd.newOid === ZERO_OID) {
        accepted.push(cmd);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      const obj = lookup(cmd.newOid);
      if (!obj) {
        results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        accepted.push(cmd);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      // Update: must fast-forward (or be the same object).
      if (cmd.newOid === cmd.oldOid) {
        accepted.push(cmd);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      const isTag = cmd.ref.startsWith('refs/tags/');
      const ff = isTag ? false : isAncestor(cmd.oldOid, cmd.newOid, lookup);
      if (!ff) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      accepted.push(cmd);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    for (const [oid, obj] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    for (const cmd of accepted) {
      if (cmd.newOid === ZERO_OID) {
        repo.refs.delete(cmd.ref);
        repo.branchFiles.delete(cmd.ref);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        if (cmd.ref.startsWith('refs/heads/')) {
          // Refresh the branch's flattened file map from the new tip.
          const tip = repo.objects.get(cmd.newOid);
          if (tip && tip.type === 'commit') {
            const files = new Map<string, string>();
            const walk = (treeOid: string, prefix: string): void => {
              const t = repo.objects.get(treeOid);
              if (!t || t.type !== 'tree') return;
              for (const e of parseTree(t.data)) {
                const path = prefix ? `${prefix}/${e.name}` : e.name;
                if (e.mode === '40000') walk(e.oid, path);
                else files.set(path, e.oid);
              }
            };
            walk(parseCommit(tip.data).tree, '');
            repo.branchFiles.set(cmd.ref, files);
          }
        }
      }
    }
    repo.updatedAt = new Date().toISOString();
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  // Real git sends the whole report-status stream (pkt-framed lines + an inner
  // flush) as band-1 sideband data, possibly split across several packets.
  // Without the inner flush the client waits for another report line and
  // reports "the remote end hung up".
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  for (let i = 0; i < inner.length; i += 65515) {
    const chunk = inner.subarray(i, i + 65515);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
}

/** The git object id of a blob/tree/commit, for callers that hash content. */
export function oidOf(type: GitObjectType, data: Buffer): string {
  return hashObject(type, data);
}
