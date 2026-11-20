// The forge's HTTP server: routing for git smart HTTP, REST v3, GraphQL v4
// and MCP, plus the starter's /healthz probe. Every reply is JSON (except
// the git binary surfaces) and carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body, bounded so a huge body cannot exhaust process memory. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | null, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'x-github-request-id': randomUUID(),
    ...extra,
  };
  if (body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), extra);
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(store, req, res);
      } catch (err) {
        // Never crash on a bad request: answer JSON and keep serving.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // the socket is already gone; nothing left to do
        }
      }
    })();
  });
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const headers = headersOf(req);

  // The env's boot probe.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method === 'DELETE') {
      send(res, 200, JSON_TYPE, Buffer.from('{}\n', 'utf8'));
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const result = handleMcp(store, body, headers);
    if (result.body === null) {
      send(res, result.status, JSON_TYPE, null, result.headers);
    } else {
      send(res, result.status, JSON_TYPE, result.body, result.headers);
    }
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    const auth = headers['authorization'] ?? '';
    const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    const authorized = expected ? auth === `Bearer ${expected}` : auth.startsWith('Bearer ') && auth.length > 7;
    const result = handleGraphQL(store, body, authorized);
    sendJson(res, result.status, result.body);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    const owner = decodeURIComponent(gitMatch[1]!);
    const repo = decodeURIComponent(gitMatch[2]!);
    const rest = gitMatch[3]!;
    if (method === 'GET' && rest.startsWith('info/refs')) {
      const service = url.searchParams.get('service') ?? '';
      const gitProtocol = headers['git-protocol'] ?? null;
      const result = handleInfoRefs(store, owner, repo, service, gitProtocol);
      if (result.status === 404) {
        sendJson(res, 404, { message: 'Not Found' });
      } else {
        send(res, result.status, result.contentType, result.body);
      }
      return;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      const body = await readBody(req);
      const gitProtocol = headers['git-protocol'] ?? null;
      const result = handleUploadPack(store, owner, repo, body, gitProtocol);
      if (result.status === 404) sendJson(res, 404, { message: 'Not Found' });
      else if (result.status >= 400) sendJson(res, result.status, JSON.parse(result.body.toString('utf8')));
      else send(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      const body = await readBody(req);
      const result = handleReceivePack(store, owner, repo, body);
      if (result.status === 404) sendJson(res, 404, { message: 'Not Found' });
      else send(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path.split('/').filter((s) => s.length > 0).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    const body = await readBody(req);
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const restReq: RestRequest = { method, segments, query: url.searchParams, headers, body, origin };
    const result = handleRest(store, restReq);
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (result.body === null) {
      send(res, result.status, JSON_TYPE, null, result.headers);
    } else {
      send(res, result.status, JSON_TYPE, result.body, result.headers);
    }
    return;
  }

  // Anything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
