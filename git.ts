// git.ts — git smart HTTP: pkt-line framing, packfile parse/generate, and the
// upload-pack (v2/v0) and receive-pack (v0) handlers. Node stdlib only
// (node:crypto for SHA-1, node:zlib for deflate/inflate). Objects are stored
// byte-for-byte; the server never re-serialises a commit, tree or tag it did
// not create itself, so clones are byte-identical to what was pushed.
//
// Security bounds (security-audit-skill, guidance mode): request bodies are
// capped by the caller, each inflated pack entry and each delta target is
// capped at 64 MiB, delta chains are cycle-checked, and every object hash is
// verified before it is stored.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { hashObject, isOid, parseCommit, parseTagTarget, parseTree, ZERO_OID, type GitObj, type ObjType, type Repo } from './store.ts';

export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// --- pkt-line ---------------------------------------------------------------
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const header = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt { kind: 'data' | 'flush' | 'delim' | 'end'; data: Buffer }
/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pktline-truncated');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('pktline-header');
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush', data: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', data: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', data: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 3) throw new Error('pktline-header');
    if (len > 65520) throw new Error('pktline-too-long');
    if (off + len > buf.length) throw new Error('pktline-truncated');
    out.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function pktLines(pkts: Pkt[]): string[] {
  return pkts.filter((p) => p.kind === 'data').map((p) => p.data.toString('utf8'));
}

// --- packfile ---------------------------------------------------------------
const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function readVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x0f;
  let shift = 4;
  let i = off;
  while (buf[i] & 0x80) {
    i += 1;
    if (i >= buf.length || shift > 63) throw new Error('pack-corrupt');
    value += (buf[i] & 0x7f) << shift;
    shift += 7;
  }
  return { value, next: i + 1 };
}
function readDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let i = off;
  for (;;) {
    if (i >= buf.length) throw new Error('pack-corrupt');
    const b = buf[i];
    value = (value << 7) | (b & 0x7f);
    i += 1;
    if (!(b & 0x80)) break;
  }
  return { value, next: i };
}
function readOfsVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = buf[off] & 0x7f;
  let i = off;
  while (buf[i] & 0x80) {
    i += 1;
    if (i >= buf.length) throw new Error('pack-corrupt');
    value = ((value + 1) << 7) | (buf[i] & 0x7f);
  }
  return { value, next: i + 1 };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  const tgt = readDeltaVarint(delta, src.next);
  if (src.value !== base.length) throw new Error('delta-base-size');
  if (tgt.value > MAX_ENTRY_BYTES) throw new Error('delta-too-large');
  const out: Buffer[] = [];
  let written = 0;
  let i = tgt.next;
  while (i < delta.length) {
    const op = delta[i];
    i += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let b = 0; b < 4; b += 1) if (op & (1 << b)) { if (i >= delta.length) throw new Error('delta-corrupt'); cpOff |= delta[i] << (8 * b); i += 1; }
      for (let b = 0; b < 3; b += 1) if (op & (0x10 << b)) { if (i >= delta.length) throw new Error('delta-corrupt'); cpSize |= delta[i] << (8 * b); i += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta-corrupt');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      written += cpSize;
    } else if (op !== 0) {
      if (i + op > delta.length) throw new Error('delta-corrupt');
      out.push(delta.subarray(i, i + op));
      written += op;
      i += op;
    } else throw new Error('delta-corrupt');
    if (written > tgt.value) throw new Error('delta-size');
  }
  if (written !== tgt.value) throw new Error('delta-size');
  return Buffer.concat(out);
}

/** Parse a packfile; returns resolved objects (oid -> object). Throws on any corruption. */
export function parsePack(buf: Buffer): Map<string, GitObj> {
  if (buf.length < 32) throw new Error('pack-truncated');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!expect.equals(trailer)) throw new Error('pack-checksum');
  interface Raw { type: number; size: number; data: Buffer; baseOid?: string; baseOff?: number; offset: number }
  const raws: Raw[] = [];
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOff = off;
    const first = buf[off];
    const type = (first >> 4) & 0x7;
    const size = readVarint(buf, off);
    off = size.next;
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (type === 6) {
      const v = readOfsVarint(buf, off);
      off = v.next;
      if (v.value <= 0 || v.value > entryOff) throw new Error('pack-delta');
      baseOff = entryOff - v.value;
    } else if (type === 7) {
      if (off + 20 > buf.length) throw new Error('pack-truncated');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!(type in TYPE_NAMES)) throw new Error('pack-type');
    // Inflate the zlib stream starting at off. The stream is self-terminating;
    // grow the probe window exponentially, then binary-search the exact end
    // (inflateSync fails on a slice cut mid-stream).
    const tryEnd = (end: number): Buffer | null => {
      try {
        const d = inflateSync(buf.subarray(off, Math.min(end, buf.length - 20)));
        return d.length === size.value ? d : null;
      } catch { return null; }
    };
    let lo = off + 1;
    let hi = off + 1;
    let data = tryEnd(hi);
    while (data === null) {
      lo = hi;
      hi = off + (hi - off) * 2 + 1;
      if (hi > buf.length - 20) hi = buf.length - 20;
      data = tryEnd(hi);
      if (hi === buf.length - 20 && data === null) throw new Error('pack-zlib');
    }
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const d = tryEnd(mid);
      if (d !== null) { hi = mid; data = d; } else lo = mid;
    }
    if (data.length !== size.value) throw new Error('pack-size');
    if (data.length > MAX_ENTRY_BYTES) throw new Error('pack-too-large');
    raws.push({ type, size: size.value, data, baseOid, baseOff, offset: entryOff });
    off = hi;
  }
  if (off !== buf.length - 20) throw new Error('pack-trailing');
  // Resolve deltas (recursively, cycle-checked) and verify hashes.
  const byOffset = new Map<number, Raw>();
  for (const r of raws) byOffset.set(r.offset, r);
  const oidToPlain = new Map<string, Raw>();
  for (const r of raws) {
    if (r.type in TYPE_NAMES) oidToPlain.set(hashObject(TYPE_NAMES[r.type], r.data), r);
  }
  const memo = new Map<number, GitObj>();
  const resolving = new Set<number>();
  const resolve = (r: Raw): GitObj => {
    const done = memo.get(r.offset);
    if (done) return done;
    if (resolving.has(r.offset)) throw new Error('pack-delta-cycle');
    resolving.add(r.offset);
    let obj: GitObj;
    if (r.type === 6) {
      const b = byOffset.get(r.baseOff as number);
      if (!b) throw new Error('pack-delta-base');
      const base = resolve(b);
      obj = { type: base.type, data: applyDelta(base.data, r.data) };
    } else if (r.type === 7) {
      let base: GitObj | undefined;
      const plain = oidToPlain.get(r.baseOid as string);
      if (plain) base = resolve(plain);
      if (!base) {
        for (const cand of raws) {
          if (cand.type !== 6 && cand.type !== 7) continue;
          try {
            const o = resolve(cand);
            if (hashObject(o.type, o.data) === r.baseOid) { base = o; break; }
          } catch { /* not this candidate's base; keep looking */ }
        }
      }
      if (!base) throw new Error('pack-delta-base');
      obj = { type: base.type, data: applyDelta(base.data, r.data) };
    } else {
      obj = { type: TYPE_NAMES[r.type], data: r.data };
    }
    resolving.delete(r.offset);
    memo.set(r.offset, obj);
    return obj;
  };
  const resolved = new Map<string, GitObj>();
  for (const r of raws) {
    const obj = resolve(r);
    resolved.set(hashObject(obj.type, obj.data), obj);
  }
  return resolved;
}

/** Build a plain (no-delta) packfile for the given objects. */
export function buildPack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const obj of objects) {
    const code = TYPE_CODES[obj.type];
    const size = obj.data.length;
    const header: number[] = [];
    let b = (code << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) b |= 0x80;
    header.push(b);
    while (rest !== 0) {
      let nb = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) nb |= 0x80;
      header.push(nb);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Split pack bytes into sideband band-1 pkt-lines (payload <= 65515 bytes of pack data). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65515) {
    const chunk = pack.subarray(off, Math.min(off + 65515, pack.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// --- advertisement ----------------------------------------------------------
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  for (const name of [...repo.refs.keys()].sort()) out.push({ name, oid: repo.refs.get(name) as string });
  return out;
}
function peeledOid(repo: Repo, refName: string, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'tag') return null;
  return repo.peelToCommit(oid);
}

/** GET /{owner}/{repo}.git/info/refs — returns {status, contentType, body}. */
export function infoRefs(repo: Repo | undefined, service: string, gitProtocol: string): { status: number; contentType: string; body: Buffer } {
  const isUpload = service === 'git-upload-pack';
  const ct = isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  if (!repo) return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  const chunks: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const v2 = isUpload && gitProtocol === 'version=2';
  if (v2) {
    chunks.push(
      pkt('version 2\n'),
      pkt('ls-refs\n'),
      pkt('fetch=shallow wait-for-done filter\n'),
      pkt('object-format=sha1\n'),
      pkt('agent=git-forge/1.0\n'),
      FLUSH,
    );
    return { status: 200, contentType: ct, body: Buffer.concat(chunks) };
  }
  const caps = isUpload
    ? 'side-band-64k ofs-delta thin-pack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=git-forge/1.0'
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=git-forge/1.0';
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    chunks.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`), FLUSH);
    return { status: 200, contentType: ct, body: Buffer.concat(chunks) };
  }
  const headTip = repo.defaultTip() ?? ZERO_OID;
  let first = true;
  const lines: string[] = [];
  if (headTip !== ZERO_OID) {
    lines.push(`${headTip} HEAD${first ? `\0${caps}` : ''}\n`);
    first = false;
  }
  for (const r of refs) {
    lines.push(`${r.oid} ${r.name}${first ? `\0${caps}` : ''}\n`);
    first = false;
    const peeled = peeledOid(repo, r.name, r.oid);
    if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
  }
  for (const l of lines) chunks.push(pkt(l));
  chunks.push(FLUSH);
  return { status: 200, contentType: ct, body: Buffer.concat(chunks) };
}

// --- upload-pack ------------------------------------------------------------
interface FetchReq {
  wants: string[]; haves: string[]; shallows: string[]; deepen: number | null;
}
function parseFetchV2(lines: string[]): FetchReq {
  const req: FetchReq = { wants: [], haves: [], shallows: [], deepen: null };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) req.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) req.shallows.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) req.deepen = Number.parseInt(t.slice(7), 10);
  }
  return req;
}

/**
 * Select objects for a fetch: closure(wants) minus closure(haves), honouring
 * depth. Returns the pack objects, plus shallow/unshallow boundary oids.
 */
export function selectFetch(repo: Repo, req: FetchReq): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const depth = req.deepen ?? null;
  const wantCommits = req.wants.map((w) => repo.peelToCommit(w));
  // BFS over parents with levels, starting at the want commits.
  const levels = new Map<string, number>();
  const queue: [string, number][] = wantCommits.map((w) => [w, 0] as [string, number]);
  const includedCommits = new Set<string>();
  let deepest = 0;
  while (queue.length > 0) {
    const [oid, level] = queue.shift() as [string, number];
    if (levels.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    levels.set(oid, level);
    if (depth !== null && level >= depth) continue;
    includedCommits.add(oid);
    deepest = Math.max(deepest, level);
    for (const p of parseCommit(obj.data).parents) queue.push([p, level + 1]);
  }
  // The client's shallow commits are boundaries it already holds without
  // their parents: cut the parent edges there, or a deepen would subtract
  // away exactly the parent generation it asked for.
  const haveReach = repo.reachableCut(req.haves, new Set(req.shallows));
  const shallow: string[] = [];
  if (depth !== null) {
    for (const oid of includedCommits) if (levels.get(oid) === deepest) shallow.push(oid);
    // A depth-1 fetch of a root commit still names the tip shallow.
    if (shallow.length === 0) shallow.push(...wantCommits);
  }
  const unshallow: string[] = [];
  for (const s of req.shallows) {
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => includedCommits.has(p)) || includedCommits.has(s)) unshallow.push(s);
  }
  // Object set: the included commits and their tree closures (never the
  // parents beyond the depth cut), minus what the client already has.
  const out = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const tOid = stack.pop() as string;
      if (out.has(tOid)) continue;
      const t = repo.objects.get(tOid);
      if (!t || t.type !== 'tree') continue;
      out.add(tOid);
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') stack.push(e.oid);
        else if (e.mode !== '160000') out.add(e.oid);
      }
    }
  };
  for (const oid of includedCommits) {
    out.add(oid);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'commit') addTree(parseCommit(obj.data).tree);
  }
  for (const w of req.wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') out.add(w);
  }
  const objects: GitObj[] = [];
  for (const oid of out) {
    if (haveReach.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, shallow, unshallow };
}

export function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string): { status: number; contentType: string; body: Buffer } {
  const ct = 'application/x-git-upload-pack-result';
  let pkts: Pkt[];
  try { pkts = decodePkts(body); } catch { return { status: 400, contentType: ct, body: Buffer.from('bad pkt-line') }; }
  const lines = pktLines(pkts);
  const first = lines[0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length).trim();
    const args = lines.slice(1);
    if (command === 'ls-refs') return { status: 200, contentType: ct, body: lsRefs(repo, args) };
    if (command === 'fetch') return { status: 200, contentType: ct, body: fetchV2(repo, args) };
    return { status: 400, contentType: ct, body: Buffer.from('unknown command') };
  }
  // v0 fetch: want lines, flush, have lines, done, flush.
  return { status: 200, contentType: ct, body: fetchV0(repo, lines) };
}

function lsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    const t = a.trim();
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') unborn = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length).trim());
  }
  const chunks: Buffer[] = [];
  const refs = sortedRefs(repo);
  const headTip = repo.defaultTip();
  const emit = (oid: string, name: string, extra = ''): void => {
    chunks.push(pkt(`${oid} ${name}${extra}\n`));
  };
  if (prefixes.length === 0) {
    if (headTip) emit(headTip, 'HEAD', ' symref-target:refs/heads/main');
    else if (unborn) emit('unborn', 'refs/heads/main', ' symref-target:refs/heads/main');
    for (const r of refs) {
      let extra = '';
      if (peel) { const p = peeledOid(repo, r.name, r.oid); if (p) extra += ` peeled:${p}`; }
      emit(r.oid, r.name, extra);
    }
  } else {
    // HEAD is a ref like any other under a prefix: it is returned only when
    // some prefix matches it (real git asks for ref-prefix HEAD; the suite
    // asks for refs/heads/ and must not see HEAD there).
    if (headTip && prefixes.some((p) => 'HEAD'.startsWith(p))) {
      emit(headTip, 'HEAD', ' symref-target:refs/heads/main');
    } else if (!headTip && unborn && prefixes.some((p) => 'refs/heads/main'.startsWith(p))) {
      emit('unborn', 'refs/heads/main', ' symref-target:refs/heads/main');
    }
    for (const r of refs) {
      if (!prefixes.some((p) => r.name.startsWith(p))) continue;
      let extra = '';
      if (peel) { const p = peeledOid(repo, r.name, r.oid); if (p) extra += ` peeled:${p}`; }
      emit(r.oid, r.name, extra);
    }
    void symrefs;
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

function fetchV2(repo: Repo, args: string[]): Buffer {
  const req = parseFetchV2(args);
  const { objects, shallow, unshallow } = selectFetch(repo, req);
  const chunks: Buffer[] = [];
  // Real git (and the protocol) omits the acknowledgments section entirely
  // when the request carries no haves: the client goes straight to the
  // packfile section and fails on anything else.
  if (req.haves.length > 0) {
    chunks.push(pkt('acknowledgments\n'));
    const acked = req.haves.filter((h) => {
      // ACK when a have is an ancestor of (or equal to) a want.
      return req.wants.some((w) => repo.isAncestor(h, w));
    });
    if (acked.length > 0) {
      for (const a of acked) chunks.push(pkt(`ACK ${a}\n`));
      chunks.push(pkt('ready\n'));
    } else {
      chunks.push(pkt('NAK\n'));
    }
    chunks.push(FLUSH);
  }
  if (req.deepen !== null || unshallow.length > 0) {
    chunks.push(pkt('shallow-info\n'));
    for (const s of shallow) chunks.push(pkt(`shallow ${s}\n`));
    for (const s of unshallow) chunks.push(pkt(`unshallow ${s}\n`));
    chunks.push(FLUSH);
  }
  if (objects.length > 0) {
    const pack = buildPack(objects);
    chunks.push(pkt('packfile\n'));
    for (const p of sidebandPack(pack)) chunks.push(p);
    chunks.push(FLUSH);
  }
  return Buffer.concat(chunks);
}

function fetchV0(repo: Repo, lines: string[]): Buffer {
  const req: FetchReq = { wants: [], haves: [], shallows: [], deepen: null };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('want ')) req.wants.push(t.slice(5).split(' ')[0]);
    else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) req.shallows.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) req.deepen = Number.parseInt(t.slice(7), 10);
  }
  const { objects, shallow, unshallow } = selectFetch(repo, req);
  const chunks: Buffer[] = [];
  const acked = req.haves.filter((h) => req.wants.some((w) => repo.isAncestor(h, w)));
  if (acked.length > 0) {
    for (const a of acked) chunks.push(pkt(`ACK ${a}\n`));
  } else chunks.push(pkt('NAK\n'));
  for (const s of shallow) chunks.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) chunks.push(pkt(`unshallow ${s}\n`));
  if (objects.length > 0) {
    const pack = buildPack(objects);
    for (const p of sidebandPack(pack)) chunks.push(p);
  }
  chunks.push(FLUSH);
  return Buffer.concat(chunks);
}

// --- receive-pack -----------------------------------------------------------
interface PushCmd { oldOid: string; newOid: string; ref: string }
export function handleReceivePack(repo: Repo, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const ct = 'application/x-git-receive-pack-result';
  // Find the byte offset just past the command-list flush; everything after
  // it is the raw packfile (never pkt-lines — decoding it as pkt-lines would
  // fail on pack bytes).
  let packStart = -1;
  {
    let o = 0;
    while (o + 4 <= body.length) {
      const head = body.subarray(o, o + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
      const len = parseInt(head, 16);
      if (len === 0) { packStart = o + 4; break; }
      if (len === 1 || len === 2) { o += 4; continue; }
      if (len < 4 || len > 65520 || o + len > body.length) break;
      o += len;
    }
  }
  if (packStart === -1) return { status: 400, contentType: ct, body: Buffer.from('missing flush') };
  let pkts: Pkt[];
  try { pkts = decodePkts(body.subarray(0, packStart)); } catch { return { status: 400, contentType: ct, body: Buffer.from('bad pkt-line') }; }
  const cmds: PushCmd[] = [];
  for (const p of pkts) {
    if (p.kind !== 'data') continue;
    const text = p.data.toString('utf8');
    const nul = text.indexOf('\0');
    const cmdText = (nul === -1 ? text : text.slice(0, nul)).trim();
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmdText);
    if (!m) continue;
    cmds.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const packBytes = body.subarray(packStart);
  const report = (unpackOk: boolean, unpackDetail: string, lines: { ref: string; ok: boolean; reason?: string }[]): Buffer => {
    const inner: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
    for (const l of lines) inner.push(pkt(l.ok ? `ok ${l.ref}\n` : `ng ${l.ref} ${l.reason ?? 'error'}\n`));
    inner.push(FLUSH);
    const innerBuf = Buffer.concat(inner);
    const out: Buffer[] = [];
    for (let o = 0; o < innerBuf.length; o += 65515) {
      out.push(pkt(Buffer.concat([Buffer.from([1]), innerBuf.subarray(o, Math.min(o + 65515, innerBuf.length))])));
    }
    out.push(FLUSH);
    return Buffer.concat(out);
  };
  if (cmds.length === 0) {
    return { status: 200, contentType: ct, body: report(true, 'ok', []) };
  }
  // Unpack first: a corrupt pack rejects every ref change.
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      return { status: 200, contentType: ct, body: report(false, 'unpacker error', cmds.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of cmds) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      else if (current.toLowerCase() !== cmd.oldOid.toLowerCase()) results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      else { repo.refs.delete(cmd.ref); results.push({ ref: cmd.ref, ok: true }); }
      continue;
    }
    if (!repo.objects.has(cmd.newOid) && !repo.objects.has(repo.peelToCommit(cmd.newOid))) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current) results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      else { repo.refs.set(cmd.ref, cmd.newOid); results.push({ ref: cmd.ref, ok: true }); }
      continue;
    }
    if (!current || current.toLowerCase() !== cmd.oldOid.toLowerCase()) {
      results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (!repo.isAncestor(cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true });
  }
  return { status: 200, contentType: ct, body: report(true, 'ok', results) };
}
