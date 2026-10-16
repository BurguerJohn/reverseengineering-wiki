/**
 * HTTP entry points: /mcp (Streamable HTTP; OAuth for remote MCP clients), /mcp/public (anonymous,
 * read-only), /oauth/* and /.well-known/oauth-* (http/oauth.ts), /auth/* (the rewiki package's
 * accounts), /health, /dumps/*.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Services } from '../tools/context.ts';
import { AuthError, type AuthService } from '../auth/service.ts';
import type { Mailer } from '../mail/index.ts';
import { createMcpServer, VERSION } from '../mcp/server.ts';
import { llmsTxt, renderSkill, toolSchemas, wellKnown } from './discovery.ts';
import { DUMP_KINDS, latestDump, listDumps } from '../dumps.ts';
import { OAuthServer, challengeHeader } from './oauth.ts';

const MAX_BODY = 2 * 1024 * 1024;
const SESSION_IDLE_MS = 60 * 60_000;

/** CORS for browser-based MCP clients: bearer tokens only, no cookies, so any origin is fine. */
const MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
};

interface McpSession {
  transport: StreamableHTTPServerTransport;
  operatorId: number;
  seen: number;
}

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

  const oauth = new OAuthServer(s, auth);

  // Remote MCP clients (OAuth) get a session each: the server may ask the human to approve a
  // publication in the middle of a tool call (elicitation), which needs the session's stream.
  const sessions = new Map<string, McpSession>();
  setInterval(() => {
    for (const session of sessions.values()) {
      if (Date.now() - session.seen > SESSION_IDLE_MS) void session.transport.close();
    }
  }, 5 * 60_000).unref();

  /** One stateless request: the rewiki package (with its token or none) and anonymous readers. */
  const stateless = async (req: IncomingMessage, res: ServerResponse, caller: Parameters<typeof createMcpServer>[1], writeTools: boolean) => {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'This endpoint is stateless: use POST.' }, { Allow: 'POST' });
      return;
    }
    const server = createMcpServer(s, caller, { includeWriteTools: writeTools });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      // ---- MCP -----------------------------------------------------------------------
      if (path === '/mcp' || path === '/mcp/public') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...MCP_CORS, 'Access-Control-Max-Age': '86400' });
          res.end();
          return;
        }
        for (const [k, v] of Object.entries(MCP_CORS)) res.setHeader(k, v);
        if (path === '/mcp/public') {
          // No account: read tools only, whatever the request carries.
          await stateless(req, res, { operator: null }, false);
          return;
        }
        const token = bearer(req);
        const session = token ? auth.authenticate(token) : null;
        if (token && !session) {
          send(res, 401, { error: 'INVALID_TOKEN', message: 'Token is invalid, expired or revoked. Log in again.' }, { 'WWW-Authenticate': challengeHeader(s, 'invalid_token') });
          return;
        }
        const proxy = req.headers['x-rewiki-client'] === 'rewiki';
        if (!session && !proxy) {
          // MCP clients log in with OAuth from here (the header says where); anonymous reading is /mcp/public.
          send(res, 401, {
            error: 'AUTH_REQUIRED',
            message: `This endpoint needs a ReverseEngineering.wiki login (OAuth), which your MCP client opens for you. To read without an account, use ${s.config.publicUrl}/mcp/public.`,
          }, { 'WWW-Authenticate': challengeHeader(s) });
          return;
        }
        if (!session?.token.oauth_client_id) {
          // The rewiki package: it asks the human for review approvals itself.
          await stateless(req, res, { operator: session?.operator ?? null }, true);
          return;
        }
        const sid = req.headers['mcp-session-id'];
        if (typeof sid === 'string') {
          const existing = sessions.get(sid);
          if (!existing || existing.operatorId !== session.operator.id) {
            send(res, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found: initialize a new one' }, id: null });
            return;
          }
          existing.seen = Date.now();
          await existing.transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
          return;
        }
        if (req.method !== 'POST') {
          send(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Mcp-Session-Id header required' }, id: null });
          return;
        }
        const server = createMcpServer(s, { operator: session.operator }, { includeWriteTools: true, serverReview: true, accounts: auth });
        const operatorId = session.operator.id;
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, operatorId, seen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          void server.close();
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, await readBody(req));
        return;
      }

      // ---- OAuth (remote MCP clients) ------------------------------------------------
      if (await oauth.handle(req, res, path, clientIp(req))) return;

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
      if (path === '/tools.json') {
        send(res, 200, await toolSchemas(s), { 'Cache-Control': 'public, max-age=300' });
        return;
      }
      if (path === '/skill/rewiki/SKILL.md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        res.end(renderSkill(s.config));
        return;
      }
      if (path === '/llms.txt') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
        res.end(llmsTxt(s.config));
        return;
      }
      if (path === '/.well-known/mcp.json') {
        send(res, 200, wellKnown(s.config), { 'Cache-Control': 'public, max-age=300' });
        return;
      }
      if (path === '/') {
        send(res, 200, {
          name: 'ReverseEngineering.wiki gateway', version: VERSION, mcp: `${s.config.publicUrl}/mcp`, mcp_public: `${s.config.publicUrl}/mcp/public`, wiki: s.config.mw.publicUrl,
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
