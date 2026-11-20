// HTTP wiring: git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3.
// GraphQL (/api/graphql) and MCP (/mcp) are session B's surface; until then they
// answer the same JSON 404 as any unknown route. See INTERFACE.md.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, MAX_BODY_BYTES } from './store.ts';
import { handleGit, type GitRequest } from './git.ts';
import { handleRest } from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new Error('request body over 64 MiB'));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? null;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
      }

      // The env's boot check calls this twice: 200 {"ok":true}. No token needed.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { message: 'Request body too large' });
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/info/refs | /git-upload-pack | /git-receive-pack
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
      if (gitMatch !== null) {
        const [, owner, repoName, suffix] = gitMatch as [string, string, string, string | undefined];
        let action: GitRequest['action'] | null = null;
        if (suffix === '/info/refs') action = 'info-refs';
        else if (suffix === '/git-upload-pack') action = 'upload-pack';
        else if (suffix === '/git-receive-pack') action = 'receive-pack';
        if (action === null) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end();
          return;
        }
        const result = handleGit(store, {
          method,
          action,
          owner,
          repoName,
          service: query.get('service'),
          gitProtocolV2: (headers['git-protocol'] ?? '') === 'version=2',
          body,
        });
        res.writeHead(result.status, { 'content-type': result.contentType, 'content-length': result.body.length });
        res.end(result.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const result = handleRest(store, { token }, {
          method,
          path: restPath,
          query,
          headers,
          body,
          host: headers.host ?? 'localhost',
        });
        res.writeHead(result.status, { ...result.headers, 'content-length': Buffer.byteLength(result.body) });
        res.end(result.body);
        return;
      }

      // Everything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}
