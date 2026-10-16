/** Shared pieces of the gateway's own web pages (OAuth authorization, review approvals). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AccountsDb } from '../db/accounts.ts';

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#0f172a"/><path d="M12 21 L22 32 L12 43 M52 21 L42 32 L52 43" fill="none" stroke="#f8fafc" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="32" r="4.5" fill="#22c55e"/></svg>';

export const STYLE = `
:root{--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--bg:#f8fafc;--card:#fff;--accent:#16a34a;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--ink:#e2e8f0;--muted:#94a3b8;--line:#334155;--bg:#0b1120;--card:#111827;--accent:#22c55e;--warn:#f59e0b;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:460px;margin:40px auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
header{display:flex;align-items:center;gap:12px;margin-bottom:20px}header b{font-size:18px}header span{color:var(--accent);font-weight:700}
h1{font-size:20px;margin:0 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}input[type=email],input[type=text]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font-size:16px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:10px 0}.check input{margin-top:4px}
button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--ink);color:var(--bg);font-size:16px;font-weight:600;cursor:pointer}
button.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
.row{display:flex;gap:10px}.row button{flex:1}
details{margin-top:20px;border-top:1px solid var(--line);padding-top:14px}summary{cursor:pointer;font-weight:600}
.notice{border-left:3px solid var(--warn);padding:6px 10px;margin:12px 0;font-size:14px}.error{border-left-color:var(--err)}
.client{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:12px 0;font-size:14px}
code{font-size:13px}a{color:var(--accent)}`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ReverseEngineering.wiki</title><meta name="robots" content="noindex"><style>${STYLE}</style></head>
<body><main><header>${ICON}<b>ReverseEngineering<span>.wiki</span></b></header><div class="card">${body}</div></main></body></html>`;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
};

export function cookieValue(req: IncomingMessage, name: string): string {
  return String(req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export function cookie(site: string, name: string, value: string, path: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${site.startsWith('https://') ? '; Secure' : ''}`;
}

/** The human's browser session on the review pages: 90 days, set at login there or when authorizing a client. */
export const SESSION_COOKIE = 'rewiki_session';
const SESSION_DAYS = 90;

export function newWebSession(db: AccountsDb, site: string, operatorId: number): string {
  const token = randomBytes(32).toString('base64url');
  db.insertWebSession(createHash('sha256').update(token).digest('hex'), operatorId, Date.now() + SESSION_DAYS * 86_400_000);
  return cookie(site, SESSION_COOKIE, token, '/review', SESSION_DAYS * 86400);
}

export function webSessionOperator(db: AccountsDb, req: IncomingMessage): number | undefined {
  const token = cookieValue(req, SESSION_COOKIE);
  return token ? db.webSessionOperator(createHash('sha256').update(token).digest('hex')) : undefined;
}

export function sendHtml(res: ServerResponse, status: number, body: string, cookies: string[] = []): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end(body);
}
