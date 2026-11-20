// Git smart HTTP: protocol v2 upload-pack, v0 upload-pack fallback, v0 receive-pack.
// Node stdlib only (node:crypto SHA-1, node:zlib deflate/inflate). No git binary.
// Objects are stored and returned byte-for-byte; packs are plain (no deltas on send),
// deltas are understood on receive.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  MAX_BODY_BYTES,
  isOid,
  hashObject,
  parseCommit,
  parseTree,
  parseTag,
  resolveRepo,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

const PKT_LINE_MAX = 65520;
const AGENT = 'forge/1.0';

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktLine {
  kind: PktKind;
  data?: Buffer;
}

export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > PKT_LINE_MAX) throw new Error('pkt-line too long');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Decode a whole pkt-line stream. Throws on invalid header, length 3, overflow or truncation. */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('pktline-truncated');
    const header = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('pktline-header');
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      i += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      i += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      i += 4;
    } else if (length === 3 || length > PKT_LINE_MAX) {
      throw new Error('pktline-too-long');
    } else {
      if (i + length > buf.length) throw new Error('pktline-truncated');
      out.push({ kind: 'data', data: buf.subarray(i + 4, i + length) });
      i += length;
    }
  }
  return out;
}

function pktText(text: string): Buffer {
  return pktLine(text);
}

/** Split sideband band-1 data into pkt-lines of at most 65515 payload bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // 65515 data bytes after the 1 band byte
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, Math.min(data.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deltas

function readVarintDelta(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('delta-corrupt');
    const byte = buf[i] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i += 1;
    if ((byte & 0x80) === 0) break;
    if (shift > 63) throw new Error('delta-corrupt');
  }
  return { value, next: i };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readVarintDelta(delta, 0);
  if (source.value !== base.length) throw new Error('delta-base-size');
  const target = readVarintDelta(delta, source.next);
  const out: Buffer[] = [];
  let written = 0;
  let i = target.next;
  while (i < delta.length) {
    const opcode = delta[i] as number;
    i += 1;
    if (opcode === 0) throw new Error('delta-corrupt');
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (i >= delta.length) throw new Error('delta-corrupt');
          copyOffset |= (delta[i] as number) << (bit * 8);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (i >= delta.length) throw new Error('delta-corrupt');
          copySize |= (delta[i] as number) << (bit * 8);
          i += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta-corrupt');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else {
      const size = opcode & 0x7f;
      if (i + size > delta.length) throw new Error('delta-corrupt');
      out.push(delta.subarray(i, i + size));
      written += size;
      i += size;
    }
    if (written > target.value) throw new Error('delta-size');
  }
  if (written !== target.value) throw new Error('delta-size');
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Packfiles

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  baseOffset?: number;
  baseOid?: string;
  data: Buffer; // inflated delta payload, or the object data for plain entries
}

function readSizeVarint(buf: Buffer, offset: number): { size: number; typeCode: number; next: number } {
  if (offset >= buf.length) throw new Error('pack-truncated');
  const first = buf[offset] as number;
  let size = first & 0x0f;
  const typeCode = (first >> 4) & 0x07;
  let shift = 4;
  let i = offset + 1;
  if ((first & 0x80) !== 0) {
    for (;;) {
      if (i >= buf.length) throw new Error('pack-truncated');
      const byte = buf[i] as number;
      size += (byte & 0x7f) << shift;
      shift += 7;
      i += 1;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error('pack-corrupt');
    }
  }
  return { size, typeCode, next: i };
}

function readOfsVarint(buf: Buffer, offset: number): { value: number; next: number } {
  if (offset >= buf.length) throw new Error('pack-truncated');
  let value = buf[offset] as number & 0x7f;
  let i = offset + 1;
  while (((buf[i - 1] as number) & 0x80) !== 0) {
    if (i >= buf.length) throw new Error('pack-truncated');
    value = ((value + 1) << 7) | ((buf[i] as number) & 0x7f);
    i += 1;
  }
  return { value, next: i };
}

/**
 * Smallest k such that inflateSync(buf[offset..offset+k]) succeeds.
 * inflateSync tolerates trailing bytes, so the predicate is monotone in k.
 */
function inflateConsumed(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  const ok = (k: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, offset + k));
    } catch {
      return null;
    }
  };
  const full = ok(remaining);
  if (full === null) throw new Error('pack-zlib');
  let lo = 1;
  let hi = remaining;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = ok(lo);
  if (data === null) throw new Error('pack-zlib');
  return { data, consumed: lo };
}

const TYPE_BY_CODE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/**
 * Parse a packfile into oid -> {type, data}. Verifies the header, the trailer
 * checksum, every entry's declared size and every object's SHA-1. Throws on
 * any corruption; never returns a partial pack.
 */
export function parsePack(buf: Buffer): Map<string, { type: GitObjectType; data: Buffer }> {
  if (buf.length < 32) throw new Error('pack-truncated');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack-header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack-version');
  const count = buf.readUInt32BE(8);
  const trailerAt = buf.length - 20;
  const expectTrailer = createHash('sha1').update(buf.subarray(0, trailerAt)).digest();
  if (!expectTrailer.equals(buf.subarray(trailerAt))) throw new Error('pack-checksum');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let n = 0; n < count; n += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(buf, offset);
    offset = header.next;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (header.typeCode === 6) {
      const ofs = readOfsVarint(buf, offset);
      offset = ofs.next;
      baseOffset = entryOffset - ofs.value;
      if (baseOffset < 0 || baseOffset >= entryOffset) throw new Error('pack-delta');
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerAt) throw new Error('pack-truncated');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (TYPE_BY_CODE[header.typeCode] === undefined) {
      throw new Error('pack-type');
    }
    const inflated = inflateConsumed(buf, offset);
    offset += inflated.consumed;
    if (inflated.data.length !== header.size) throw new Error('pack-size');
    if (header.size > MAX_BODY_BYTES) throw new Error('pack-size');
    if (offset > trailerAt) throw new Error('pack-truncated');
    const entry: RawEntry = {
      offset: entryOffset,
      typeCode: header.typeCode,
      size: header.size,
      baseOffset,
      baseOid,
      data: inflated.data,
    };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerAt) throw new Error('pack-trailing');

  const resolved = new Map<number, { type: GitObjectType; data: Buffer; oid: string }>();
  const resolving = new Set<number>();
  const resolveEntry = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('pack-delta-cycle');
    resolving.add(entry.offset);
    try {
      let result: { type: GitObjectType; data: Buffer; oid: string };
      if (entry.typeCode === 6 || entry.typeCode === 7) {
        let base: { type: GitObjectType; data: Buffer; oid: string } | undefined;
        if (entry.baseOffset !== undefined) {
          const baseEntry = byOffset.get(entry.baseOffset);
          if (baseEntry !== undefined) base = resolveEntry(baseEntry);
        }
        if (base === undefined && entry.baseOid !== undefined) {
          for (const candidate of resolved.values()) {
            if (candidate.oid === entry.baseOid) {
              base = candidate;
              break;
            }
          }
        }
        if (base === undefined) throw new Error('pack-delta-base');
        const data = applyDelta(base.data, entry.data);
        const oid = hashObject(base.type, data);
        result = { type: base.type, data, oid };
      } else {
        const type = TYPE_BY_CODE[entry.typeCode] as GitObjectType;
        const oid = hashObject(type, entry.data);
        result = { type, data: entry.data, oid };
      }
      resolved.set(entry.offset, result);
      return result;
    } finally {
      resolving.delete(entry.offset);
    }
  };

  const out = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const entry of raw) {
    const item = resolveEntry(entry);
    out.set(item.oid, { type: item.type, data: item.data });
  }
  if (out.size !== count) throw new Error('pack-count');
  return out;
}

/** Build a plain (no-delta) pack v2 from objects, deterministic oid order. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const dedup = new Map<string, { type: GitObjectType; data: Buffer }>();
  for (const obj of objects) dedup.set(hashObject(obj.type, obj.data), obj);
  const items = [...dedup.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(items.length, 8);
  parts.push(header);
  const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const [, obj] of items) {
    const compressed = deflateSync(obj.data);
    let size = obj.data.length;
    const typeCode = TYPE_CODE[obj.type];
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Fetch object selection

interface FetchSelection {
  objects: Set<string>;
  shallowLines: string[];
  unshallowLines: string[];
  ackOid: string | null;
}

function ownedSet(repo: Repo, haves: string[], clientShallow: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid) || !isOid(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!clientShallow.has(oid)) stack.push(...info.parents);
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

function selectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: Set<string>,
  deepen: number | null,
): FetchSelection {
  const depthLimit = deepen ?? Number.POSITIVE_INFINITY;
  const wanted = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: [string, number][] = [];
  for (const want of wants) {
    const obj = repo.getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      wanted.add(want);
      queue.push([repo.peel(want), 1]);
    } else if (obj.type === 'commit') {
      queue.push([want, 1]);
    } else {
      wanted.add(want);
    }
  }
  while (queue.length > 0) {
    const [oid, depth] = queue.shift() as [string, number];
    if (commitDepth.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    commitDepth.set(oid, depth);
    wanted.add(oid);
    const info = parseCommit(obj.data);
    for (const member of repo.reachable([info.tree])) wanted.add(member);
    if (depth < depthLimit) {
      for (const parent of info.parents) queue.push([parent, depth + 1]);
    }
  }
  const owned = ownedSet(repo, haves, clientShallow);
  const objects = new Set<string>();
  for (const oid of wanted) {
    if (!owned.has(oid)) objects.add(oid);
  }

  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (deepen !== null) {
    for (const [oid, depth] of commitDepth) {
      if (depth === deepen) shallowLines.push(`shallow ${oid}`);
      else if (clientShallow.has(oid)) unshallowLines.push(`unshallow ${oid}`);
    }
    shallowLines.sort();
    unshallowLines.sort();
  }

  let ackOid: string | null = null;
  for (const have of haves) {
    if (!isOid(have) || have === ZERO_OID) continue;
    for (const want of wants) {
      if (have === want || repo.isAncestor(have, want)) {
        ackOid = have;
        break;
      }
    }
    if (ackOid !== null) break;
  }
  return { objects, shallowLines, unshallowLines, ackOid };
}

// ---------------------------------------------------------------------------
// Advertisements

function refLines(repo: Repo): { oid: string; name: string; peeled?: string }[] {
  const lines: { oid: string; name: string; peeled?: string }[] = [];
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of [...heads, ...tags]) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.getObject(oid);
    const line: { oid: string; name: string; peeled?: string } = { oid, name };
    if (obj !== undefined && obj.type === 'tag') line.peeled = repo.peel(oid);
    lines.push(line);
  }
  return lines;
}

function advertiseV0(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main'
      : 'side-band-64k ofs-delta thin-pack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
  const parts: Buffer[] = [pktText(`# service=${service}\n`), pktFlush()];
  const lines: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  // A zero-OID HEAD is never advertised when the default branch does not exist.
  if (defaultTip !== undefined) lines.push(`${defaultTip} HEAD`);
  for (const line of refLines(repo)) {
    lines.push(`${line.oid} ${line.name}`);
    if (line.peeled !== undefined) lines.push(`${line.peeled} ${line.name}^{}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  const framed = lines.map((line, index) => {
    const text = index === 0 ? `${line}\0${caps}\n` : `${line}\n`;
    return pktText(text);
  });
  parts.push(...framed, pktFlush());
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pktText('# service=git-upload-pack\n'),
    pktFlush(),
    pktText('version 2\n'),
    pktText('ls-refs=unborn\n'),
    pktText('fetch=shallow wait-for-done filter\n'),
    pktText('object-format=sha1\n'),
    pktText(`agent=${AGENT}\n`),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)

function handleLsRefs(repo: Repo, packets: PktLine[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.data === undefined) continue;
    const line = packet.data.toString('utf8').trim();
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: Buffer[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (matches('HEAD') && defaultTip !== undefined) {
    // symref-target is always carried: the client's parser only reads it.
    out.push(pktText(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const line of refLines(repo)) {
    if (!matches(line.name)) continue;
    const peeled = peel && line.peeled !== undefined ? ` peeled:${line.peeled}` : '';
    out.push(pktText(`${line.oid} ${line.name}${peeled}\n`));
  }
  if (unborn && defaultTip === undefined && matches('HEAD')) {
    // Real git names the unborn line HEAD (its symref-target names the branch);
    // that is how a clone learns the default branch of an empty repository.
    out.push(pktText(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  out.push(pktFlush());
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch (v2 and v0)

function parseFetchV2Args(packets: PktLine[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.data === undefined) continue;
    const line = packet.data.toString('utf8').trim();
    if (!pastDelim) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  return { wants, haves, shallow, deepen, done };
}

function handleFetchV2(repo: Repo, packets: PktLine[]): Buffer {
  const { wants, haves, shallow, deepen, done } = parseFetchV2Args(packets);
  const selection = selectFetch(repo, wants, haves, new Set(shallow), deepen);
  // Real git answers the acknowledgments section only while negotiating, i.e.
  // while the client has not sent `done`. Once `done` arrives the response
  // goes straight to shallow-info / packfile; a client that sent `done`
  // expects `packfile` as the next section, not `acknowledgments`.
  // While negotiating (no `done` yet): a NAK ends the response (the client
  // sends more haves next); an ACK comes with `ready` and the response then
  // continues in the same stream — a delim, then shallow-info and packfile.
  if (!done) {
    const parts: Buffer[] = [pktText('acknowledgments\n')];
    if (selection.ackOid === null) {
      parts.push(pktText('NAK\n'), pktFlush());
      return Buffer.concat(parts);
    }
    parts.push(pktText(`ACK ${selection.ackOid}\n`), pktText('ready\n'), pktDelim());
    appendShallowAndPack(repo, selection, parts, true);
    return Buffer.concat(parts);
  }
  const parts: Buffer[] = [];
  appendShallowAndPack(repo, selection, parts, false);
  if (parts.length === 0) {
    // Nothing to send at all: a bare flush ends the response (pack: null).
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

/** Append the shallow-info section (when it has lines) and the packfile section. */
function appendShallowAndPack(repo: Repo, selection: FetchSelection, parts: Buffer[], alwaysPack: boolean): void {
  if (selection.shallowLines.length > 0 || selection.unshallowLines.length > 0) {
    parts.push(pktText('shallow-info\n'));
    for (const line of selection.shallowLines) parts.push(pktText(`${line}\n`));
    for (const line of selection.unshallowLines) parts.push(pktText(`${line}\n`));
    parts.push(pktFlush());
  }
  if (selection.objects.size > 0 || alwaysPack) {
    const packObjects = [...selection.objects].map((oid) => repo.getObject(oid) as { type: GitObjectType; data: Buffer });
    const pack = writePack(packObjects);
    parts.push(pktText('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(pktFlush());
  }
}

function parseFetchV0(packets: PktLine[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
} {
  // Two sections split by the first flush: wants, then haves + done.
  const sections: PktLine[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') sections.push([]);
    else sections[sections.length - 1]?.push(packet);
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  for (const packet of sections[0] ?? []) {
    if (packet.kind !== 'data' || packet.data === undefined) continue;
    const line = packet.data.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) deepen = n;
    }
  }
  for (const packet of sections[1] ?? []) {
    if (packet.kind !== 'data' || packet.data === undefined) continue;
    const line = packet.data.toString('utf8').trim();
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  return { wants, haves, shallow, deepen };
}

function handleFetchV0(repo: Repo, packets: PktLine[]): Buffer {
  const { wants, haves, shallow, deepen } = parseFetchV0(packets);
  const selection = selectFetch(repo, wants, haves, new Set(shallow), deepen);
  const parts: Buffer[] = [];
  if (selection.ackOid !== null) parts.push(pktText(`ACK ${selection.ackOid}\n`));
  else parts.push(pktText('NAK\n'));
  for (const line of selection.shallowLines) parts.push(pktText(`${line}\n`));
  for (const line of selection.unshallowLines) parts.push(pktText(`${line}\n`));
  if (selection.objects.size > 0) {
    const packObjects = [...selection.objects].map((oid) => repo.getObject(oid) as { type: GitObjectType; data: Buffer });
    parts.push(...sidebandPackets(writePack(packObjects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (v0)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

const REF_NAME_RE = /^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/;

function validRefName(ref: string): boolean {
  return (
    ref.length <= 200 &&
    REF_NAME_RE.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.lock')
  );
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const report = (inner: Buffer): Buffer => {
    const parts = [...sidebandPackets(inner), pktFlush()];
    return Buffer.concat(parts);
  };
  const failUnpack = (detail: string): Buffer => {
    const safe = detail.replace(/[\r\n]/g, ' ').slice(0, 200);
    return report(Buffer.concat([pktText(`unpack ${safe}\n`), pktFlush()]));
  };

  // Command list: pkt-lines up to the first flush; the rest is the raw pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  try {
    while (offset < body.length) {
      if (offset + 4 > body.length) return failUnpack('truncated command list');
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) return failUnpack('bad pkt-line header');
      const length = parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || length > PKT_LINE_MAX || offset + length > body.length) {
        return failUnpack('bad pkt-line length');
      }
      const line = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      const withoutCaps = line.split('\0')[0] as string;
      const fields = withoutCaps.trim().split(' ');
      if (fields.length < 3) return failUnpack('bad command line');
      const [oldOid, newOid, ref] = fields as [string, string, string];
      commands.push({ oldOid, newOid, ref });
    }
  } catch {
    return failUnpack('command parse error');
  }
  if (commands.length === 0) return failUnpack('no commands');

  const packBytes = body.subarray(offset);
  const hasUpdate = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let unpacked = new Map<string, { type: GitObjectType; data: Buffer }>();
  if (packBytes.length > 0) {
    try {
      unpacked = parsePack(packBytes);
    } catch (err) {
      return failUnpack(err instanceof Error ? err.message : 'pack corrupt');
    }
  } else if (hasUpdate) {
    return failUnpack('missing packfile');
  }
  for (const [oid, obj] of unpacked) {
    if (!repo.putObjectChecked(obj.type, obj.data, oid)) return failUnpack('object hash mismatch');
  }

  // Per-ref rules, applied independently (never all-or-nothing).
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  for (const cmd of commands) {
    if (!validRefName(cmd.ref)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid ref name' });
      continue;
    }
    if (!isOid(cmd.oldOid) || !isOid(cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid object id' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value mismatch' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (repo.getObject(cmd.newOid) === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    // Update.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
    } else if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
    } else if (cmd.oldOid === cmd.newOid) {
      results.push({ ref: cmd.ref, ok: true });
    } else {
      const oldTarget = repo.peel(cmd.oldOid);
      const newTarget = repo.peel(cmd.newOid);
      if (!repo.isAncestor(oldTarget, newTarget)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true });
      }
    }
  }

  const innerParts: Buffer[] = [pktText('unpack ok\n')];
  for (const result of results) {
    innerParts.push(result.ok ? pktText(`ok ${result.ref}\n`) : pktText(`ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  innerParts.push(pktFlush());
  return report(Buffer.concat(innerParts));
}

// ---------------------------------------------------------------------------
// Entry point

export interface GitRequest {
  method: string;
  action: 'info-refs' | 'upload-pack' | 'receive-pack';
  owner: string;
  repoName: string;
  service: string | null;
  gitProtocolV2: boolean;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const NOT_FOUND: GitResponse = { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.alloc(0) };

export function handleGit(store: Store, req: GitRequest): GitResponse {
  try {
    const repo = resolveRepo(store, req.owner, req.repoName);
    if (repo === null) return NOT_FOUND;
    if (req.action === 'info-refs') {
      if (req.service === 'git-upload-pack') {
        if (req.gitProtocolV2) {
          return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'git-upload-pack') };
      }
      if (req.service === 'git-receive-pack') {
        return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'git-receive-pack') };
      }
      return NOT_FOUND;
    }
    if (req.action === 'upload-pack') {
      if (req.method !== 'POST') return NOT_FOUND;
      let packets: PktLine[];
      try {
        packets = decodePktLines(req.body);
      } catch {
        return { status: 400, contentType: 'application/x-git-upload-pack-result', body: Buffer.alloc(0) };
      }
      const first = packets.find((packet) => packet.kind === 'data')?.data?.toString('utf8').trim() ?? '';
      if (first.startsWith('command=ls-refs')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, packets) };
      }
      if (first.startsWith('command=fetch')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, packets) };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, packets) };
    }
    if (req.action === 'receive-pack') {
      if (req.method !== 'POST') return NOT_FOUND;
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(repo, req.body) };
    }
    return NOT_FOUND;
  } catch {
    // Never crash the server on a malformed git request; the repo survives.
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.alloc(0) };
  }
}
