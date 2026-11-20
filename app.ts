// app.ts — HTTP server: routing, body limits, auth, and JSON replies.
// One process, Node stdlib only. All state lives in one Store shared by
// the git, REST, GraphQL and MCP handlers.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store, viewerLogin } from './store.ts';
import { handleReceivePack, handleUploadPack, infoRefs } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
const VIEWER = viewerLogin();
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length).trim();
  if (!token) return false;
  if (TOKEN === '') return true;
  return token === TOKEN;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
  });
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://entry'); } catch { url = new URL('/', 'http://entry'); }
      const path = url.pathname;
      const query = url.searchParams;

      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const tail = gitMatch[3];
        const repo = store.getRepo(owner, repoName);
        if (tail === 'info/refs' && method === 'GET') {
          const service = query.get('service') ?? '';
          const r = infoRefs(repo, service, req.headers['git-protocol'] ?? '');
          sendRaw(res, r.status, r.contentType, r.body);
          return;
        }
        if (tail === 'git-upload-pack' && method === 'POST') {
          if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) { sendJson(res, 413, { message: 'Request body too large' }); return; }
          const r = handleUploadPack(repo, body, req.headers['git-protocol'] ?? '');
          sendRaw(res, r.status, r.contentType, r.body);
          return;
        }
        if (tail === 'git-receive-pack' && method === 'POST') {
          if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return; }
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) { sendJson(res, 413, { message: 'Request body too large' }); return; }
          const r = handleReceivePack(repo, body);
          sendRaw(res, r.status, r.contentType, r.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL.
      if (path === '/api/graphql' && method === 'POST') {
        if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const { body, tooLarge } = await readBody(req);
        if (tooLarge) { sendJson(res, 413, { message: 'Request body too large' }); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] }); return; }
        const r = handleGraphQL(store, VIEWER, parsed);
        sendJson(res, r.status, r.body);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        const { body, tooLarge } = await readBody(req);
        if (tooLarge) { sendJson(res, 413, { message: 'Request body too large' }); return; }
        const r = handleMcp(store, VIEWER, method, body, authed(req));
        if (r.status === 202) { res.writeHead(202, { 'content-length': 0 }); res.end(); return; }
        sendJson(res, r.status, r.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        let parsed: unknown = null;
        let bodyError = false;
        if (needsBody) {
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) { sendJson(res, 413, { message: 'Request body too large' }); return; }
          if (body.length > 0) {
            try { parsed = JSON.parse(body.toString('utf8')); } catch { bodyError = true; }
          }
        }
        const r = handleRest(store, VIEWER, method, path, query, parsed, bodyError);
        const headers: Record<string, string> = { ...(r.headers ?? {}) };
        // The Link header must be an absolute same-origin URL; make it so.
        if (headers.link) {
          const host = req.headers.host ?? 'localhost';
          headers.link = headers.link.replace(/<([^>]+)>/g, (_m, p1: string) => {
            const u = String(p1);
            return `<${u.startsWith('http') ? u : `http://${host}${u}`}>`;
          });
        }
        if (r.status === 204) {
          res.writeHead(204, { 'x-github-request-id': randomUUID(), ...headers });
          res.end();
          return;
        }
        sendJson(res, r.status, r.body, headers);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      try { sendJson(res, 500, { message: 'Internal Server Error' }); } catch { /* socket gone */ }
    });
  });
}
