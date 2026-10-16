/** HTTP entry points: /mcp (Streamable HTTP, stateless), /auth/* (accounts), /health, /dumps/*. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Services } from '../tools/context.ts';
import { AuthError, type AuthService } from '../auth/service.ts';
import type { Mailer } from '../mail/index.ts';
import { createMcpServer, VERSION } from '../mcp/server.ts';
import { CLIENT_DIR, clientTarball, llmsTxt, wellKnown } from './discovery.ts';
import { DUMP_KINDS, latestDump, listDumps } from '../dumps.ts';

const MAX_BODY = 2 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AuthError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AuthError('BAD_REQUEST', 'Body must be JSON');
  }
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

export function createHttpServer(s: Services, auth: AuthService, mailer: Mailer) {
  const clientIp = (req: IncomingMessage): string => {
    if (s.config.trustProxy) {
      // The last entry is the one our reverse proxy appended; earlier ones are client-supplied.
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1)!.trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // ---- MCP -----------------------------------------------------------------------
      if (path === '/mcp') {
        if (req.method !== 'POST') {
          send(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'This server is stateless: use POST.' }, { Allow: 'POST' });
          return;
        }
        const token = bearer(req);
        const session = token ? auth.authenticate(token) : null;
        if (token && !session) {
          send(res, 401, { error: 'INVALID_TOKEN', message: 'Token is invalid, expired or revoked. Log in again.' });
          return;
        }
        const proxy = req.headers['x-rewiki-client'] === 'rewiki';
        const server = createMcpServer(s, { operator: session?.operator ?? null }, { includeWriteTools: !!session || proxy });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, await readBody(req));
        return;
      }

      // ---- accounts ------------------------------------------------------------------
      if (path.startsWith('/auth/')) {
        const route = `${req.method} ${path}`;
        const body = req.method === 'POST' ? ((await readBody(req)) as any) ?? {} : {};
        const ip = clientIp(req);
        switch (route) {
          case 'POST /auth/username-available':
            send(res, 200, await auth.usernameAvailable(body.username));
            return;
          case 'POST /auth/register/start':
            send(res, 200, await auth.registerStart(body, ip));
            return;
          case 'POST /auth/register/verify':
            send(res, 200, await auth.registerVerify(body));
            return;
          case 'POST /auth/login/start':
            send(res, 200, await auth.loginStart(body, ip));
            return;
          case 'POST /auth/login/verify':
            send(res, 200, await auth.loginVerify(body));
            return;
          case 'POST /auth/web/start':
          case 'POST /auth/web/verify': {
            // Called server-side by the wiki's login form, never by browsers: shared secret,
            // and only on a direct connection (requests through the public proxy carry X-Forwarded-For).
            const given = Buffer.from(String(req.headers['x-rewiki-web-secret'] ?? ''));
            const expected = Buffer.from(s.config.webLoginSecret);
            const direct = !req.headers['x-forwarded-for'];
            if (!expected.length || !direct || given.length !== expected.length || !timingSafeEqual(given, expected)) {
              send(res, 403, { error: 'FORBIDDEN' });
              return;
            }
            send(res, 200, route.endsWith('/start') ? await auth.webLoginStart(body) : auth.webLoginVerify(body));
            return;
          }
        }
        const session = auth.authenticate(bearer(req));
        if (!session) {
          send(res, 401, { error: 'INVALID_TOKEN', message: 'Missing, invalid or expired token.' });
          return;
        }
        switch (route) {
          case 'GET /auth/status':
            send(res, 200, auth.status(session.operator, session.token));
            return;
          case 'POST /auth/logout':
            auth.logout(session.token);
            send(res, 200, { ok: true });
            return;
          case 'POST /auth/mode':
            send(res, 200, { mode: auth.setMode(session.operator, body.mode) });
            return;
        }
        send(res, 404, { error: 'NOT_FOUND' });
        return;
      }

      // ---- health & dumps ------------------------------------------------------------
      if (path === '/health') {
        let mail = 'ok';
        try {
          await mailer.transport.verify();
        } catch {
          mail = 'unreachable';
        }
        send(res, 200, { ok: true, version: VERSION, mail_driver: mailer.transport.name, mail, index: s.index.stats() });
        return;
      }
      if (path === '/dumps' || path === '/dumps/') {
        const latest = Object.fromEntries(Object.keys(DUMP_KINDS).map((kind) => [kind, `${s.config.publicUrl}/dumps/latest/${kind}`]));
        send(res, 200, {
          description: 'The whole wiki for download, one edition per day. Start with text.zip: one Markdown file per page, facts and builds as JSON, code as files.',
          license: 'Text: CC BY-SA 4.0 (credit "ReverseEngineering.wiki contributors" and link the page). Code: MIT-0.',
          schedule_hours: s.config.dumpIntervalHours || null,
          latest,
          formats: DUMP_KINDS,
          editions: listDumps(s.config),
        }, { 'Cache-Control': 'public, max-age=300' });
        return;
      }
      if (path.startsWith('/dumps/latest/')) {
        const file = latestDump(s.config, decodeURIComponent(path.slice('/dumps/latest/'.length)));
        if (!file) {
          send(res, 404, { error: 'NOT_FOUND', message: 'No edition of that kind yet. See /dumps.' });
          return;
        }
        res.writeHead(302, { Location: file.url, 'Cache-Control': 'public, max-age=300' });
        res.end();
        return;
      }
      if (path.startsWith('/dumps/')) {
        const name = basename(decodeURIComponent(path.slice('/dumps/'.length)));
        const file = join(s.config.dumpDir, name);
        if (!/^[\w.-]+$/.test(name) || !existsSync(file)) {
          send(res, 404, { error: 'NOT_FOUND' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': name.endsWith('.gz') ? 'application/gzip' : name.endsWith('.zip') ? 'application/zip' : name.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'Content-Length': String(statSync(file).size),
          'Content-Disposition': `attachment; filename="${name}"`,
        });
        createReadStream(file).pipe(res);
        return;
      }
      // ---- agent discovery ---------------------------------------------------------
      if (path === '/llms.txt') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        res.end(llmsTxt(s.config));
        return;
      }
      if (path === '/.well-known/mcp.json') {
        send(res, 200, wellKnown(s.config), { 'Cache-Control': 'public, max-age=300' });
        return;
      }
      if (path.startsWith('/client/')) {
        const name = basename(decodeURIComponent(path.slice('/client/'.length)));
        const file = join(CLIENT_DIR(s.config), name);
        if (!/^rewiki-\d+\.\d+\.\d+\.tgz$/.test(name) || !existsSync(file)) {
          send(res, 404, { error: 'NOT_FOUND', latest: clientTarball(s.config) });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(statSync(file).size), 'Cache-Control': 'public, max-age=86400, immutable' });
        createReadStream(file).pipe(res);
        return;
      }
      if (path === '/') {
        send(res, 200, {
          name: 'ReverseEngineering.wiki gateway', version: VERSION, mcp: `${s.config.publicUrl}/mcp`, wiki: s.config.mw.publicUrl,
          setup_instructions: `${s.config.publicUrl}/llms.txt`, dumps: `${s.config.publicUrl}/dumps`,
        });
        return;
      }
      send(res, 404, { error: 'NOT_FOUND', setup_instructions: `${s.config.publicUrl}/llms.txt` });
    } catch (error) {
      if (error instanceof AuthError) {
        send(res, error.status, { error: error.code, message: error.message, ...error.extra });
        return;
      }
      console.error('[http]', error);
      if (!res.headersSent) send(res, 500, { error: 'INTERNAL', message: 'Internal error' });
    }
  });
}
