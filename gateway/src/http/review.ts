/**
 * Review pages (/review/<id>): in review mode, the human sees exactly what their agent wants to
 * publish and approves it in their own browser. Approving needs the browser session set when
 * they logged in (here or while authorizing their MCP client), which the agent never has; on
 * another device the page asks for the email code first.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Services } from '../tools/context.ts';
import { AuthError, type AuthService } from '../auth/service.ts';
import type { ReviewRow } from '../db/accounts.ts';
import { cookie, cookieValue, esc, newWebSession, page, sendHtml, webSessionOperator } from './web.ts';

export const REVIEW_TTL_MS = 60 * 60_000;
const FLOW_COOKIE = 'rewiki_review_flow';
const FLOW_TTL_MS = 20 * 60_000;

interface LoginFlow {
  reviewId: string;
  cookie: string;
  created: number;
  challengeId?: string;
  nonce?: string;
  notice?: string;
}

export function reviewUrl(s: Services, id: string): string {
  return `${s.config.publicUrl}/review/${id}`;
}

/** Stores a publication waiting for approval; returns its id. */
export function createReview(s: Services, operatorId: number, tool: string, argsHash: string, preview: string): string {
  const id = randomBytes(16).toString('base64url');
  s.db.insertReview({ id, operator_id: operatorId, tool, args_hash: argsHash, preview, created_at: Date.now(), expires_at: Date.now() + REVIEW_TTL_MS });
  return id;
}

/** The preview as HTML: "--- New page: X ---" blocks, diff lines colored. */
function renderPreview(text: string): string {
  return text.split(/\n(?=--- (?:New page|Changes to|Undo on): )/).map((block) => {
    const [first, ...rest] = block.split('\n');
    const header = /^--- (.+) ---$/.exec(first)?.[1] ?? '';
    const lines = (header ? rest : [first, ...rest]).map((line) => {
      const cls = /^\+(?!\+\+)/.test(line) ? 'add' : /^-(?!--)/.test(line) ? 'del' : /^@@/.test(line) ? 'hunk' : '';
      return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
    });
    return `${header ? `<h2>${esc(header)}</h2>` : ''}<pre>${lines.join('\n')}</pre>`;
  }).join('');
}

const PREVIEW_STYLE = `<style>main{max-width:880px}pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13px;line-height:1.45;max-height:70vh;overflow:auto}
h2{font-size:15px;margin:18px 0 6px}.add{color:#15803d;background:rgba(34,197,94,.12);display:block}.del{color:#b91c1c;background:rgba(239,68,68,.12);display:block}.hunk{color:var(--muted);display:block}</style>`;

export class ReviewPages {
  private readonly s: Services;
  private readonly auth: AuthService;
  private readonly flows = new Map<string, LoginFlow>();

  constructor(s: Services, auth: AuthService) {
    this.s = s;
    this.auth = auth;
    setInterval(() => {
      const now = Date.now();
      for (const [id, flow] of this.flows) if (now - flow.created > FLOW_TTL_MS) this.flows.delete(id);
      s.db.pruneReviews();
    }, 10 * 60_000).unref();
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<boolean> {
    const m = /^\/review\/([A-Za-z0-9_-]{10,40})$/.exec(path);
    if (!m) return false;
    const review = this.s.db.review(m[1]);
    if (!review || review.expires_at < Date.now()) {
      sendHtml(res, 404, page('Review', '<h1>This review link expired</h1><p>Approval links last one hour. Ask your agent to try the publication again: it gets a new link.</p>'));
      return true;
    }
    if (req.method === 'POST') await this.post(req, res, review, ip);
    else this.show(req, res, review);
    return true;
  }

  private show(req: IncomingMessage, res: ServerResponse, review: ReviewRow, error?: string): void {
    const op = this.s.db.operatorById(review.operator_id);
    if (!op) return sendHtml(res, 404, page('Review', '<h1>Unknown account</h1>'));
    if (review.status !== 'pending') {
      const said = { approved: 'You approved this publication. Tell your agent: it publishes when it repeats the call.', used: 'This publication was approved and published.', declined: 'You declined this publication. Nothing was published.' }[review.status];
      return sendHtml(res, 200, page('Review', `<h1>${review.status === 'declined' ? 'Declined' : 'Approved'}</h1><p>${esc(said)}</p>`));
    }
    // Anyone with the link sees the preview: it is unguessable, and the agent already knows the content.
    // Approving is what needs the operator: the client's own prompt, or this browser signed in.
    const signedIn = webSessionOperator(this.s.db, req);
    const owner = signedIn === review.operator_id;
    const err = error ? `<p class="notice error">${esc(error)}</p>` : '';
    const actions = owner
      ? `<form method="post"><input type="hidden" name="check" value="${esc(this.check(req, review))}">
<div class="row"><button class="secondary" type="submit" name="action" value="decline">Decline</button><button type="submit" name="action" value="approve">Approve</button></div></form>
<p class="muted">After you approve, go back to your agent: it publishes when it repeats the call. This link expires one hour after it was created.</p>`
      : `<div class="client"><b>Approve it in your agent's app</b>: tick the checkbox it shows you (Claude Code, for example). Nothing else is needed.
<p class="muted">No checkbox in your app? Approve here instead: sign in once in this browser (it stays signed in for 90 days). Approving needs you, not just the link, because the link passes through your agent.</p>
${signedIn !== undefined ? '<p class="notice">This browser is signed in to another account.</p>' : ''}
<form method="post"><input type="hidden" name="action" value="email">
<label for="email">Your email</label><input id="email" name="email" type="email" autocomplete="email" required>
<button class="secondary" type="submit">Send code to approve here</button></form></div>`;
    sendHtml(res, 200, page('Review a publication', `${PREVIEW_STYLE}<h1>Publish this on ReverseEngineering.wiki?</h1>${err}
<p>Your agent wants to publish as <b>${esc(op.username)}</b> (<code>${esc(review.tool)}</code>). This is exactly what will be stored; it becomes public, under CC BY-SA 4.0 (text) and MIT-0 (code).</p>
<p class="muted">Articles are shown as Markdown; the wiki stores them as wikitext, which displays the same. In changes, green lines are added and red lines removed.</p>
${renderPreview(review.preview)}
${actions}`));
  }

  /** Ties the approve form to this browser session and this review (with the SameSite cookie, against forged posts). */
  private check(req: IncomingMessage, review: ReviewRow): string {
    return createHash('sha256').update(`${cookieValue(req, 'rewiki_session')}|${review.id}`).digest('base64url');
  }

  /** The email-code step of signing in on this page; without a pending code, the review page itself. */
  private signIn(req: IncomingMessage, res: ServerResponse, review: ReviewRow, error?: string, flow?: LoginFlow, cookies: string[] = []): void {
    const err = error ? `<p class="notice error">${esc(error)}</p>` : '';
    if (flow?.challengeId) {
      return sendHtml(res, 200, page('Enter the code', `<h1>Check your email</h1>${flow.notice ? `<p class="notice">${esc(flow.notice)}</p>` : ''}${err}
<form method="post"><input type="hidden" name="flow" value="${esc(flow.cookie)}"><input type="hidden" name="action" value="verify">
<label for="code">6-digit code</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus>
<button type="submit">Continue</button></form>`), cookies);
    }
    this.show(req, res, review, error);
  }

  private async post(req: IncomingMessage, res: ServerResponse, review: ReviewRow, ip: string): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
      if (chunks.reduce((n, c) => n + c.length, 0) > 16_384) return sendHtml(res, 413, page('Review', '<h1>Too large</h1>'));
    }
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    const site = this.s.config.publicUrl;
    try {
      if (form.action === 'approve' || form.action === 'decline') {
        if (webSessionOperator(this.s.db, req) !== review.operator_id) return this.show(req, res, review);
        const expected = Buffer.from(this.check(req, review));
        const given = Buffer.from(String(form.check ?? ''));
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return this.show(req, res, review, 'This form expired. Review it again.');
        this.s.db.setReviewStatus(review.id, 'pending', form.action === 'approve' ? 'approved' : 'declined');
        return this.show(req, res, this.s.db.review(review.id)!);
      }
      if (form.action === 'email') {
        const nonce = randomBytes(24).toString('base64url');
        const started = await this.auth.loginStart({ email: form.email, client_nonce_hash: createHash('sha256').update(nonce).digest('hex'), client_label: 'the review page' }, ip);
        const flow = this.newFlow(review.id, started.challenge_id, nonce, started.message);
        return this.signIn(req, res, review, undefined, flow, [this.flowCookie(flow)]);
      }
      if (form.action === 'verify') {
        const flow = this.flowFor(req, form.flow, review.id);
        if (!flow) return this.signIn(req, res, review, 'This sign-in expired. Start again.');
        let op;
        try {
          op = this.auth.loginOperator({ challenge_id: flow.challengeId, code: String(form.code ?? '').replace(/\s/g, ''), client_nonce: flow.nonce }).op;
        } catch (error) {
          if (error instanceof AuthError) return this.signIn(req, res, review, error.message, flow);
          throw error;
        }
        this.flows.delete(flow.cookie);
        if (op.id !== review.operator_id) return this.signIn(req, res, review, 'That account is not the one this publication belongs to. Use the email of the account your agent publishes as.');
        res.writeHead(303, { Location: `${site}/review/${review.id}`, 'Cache-Control': 'no-store', 'Set-Cookie': newWebSession(this.s.db, site, op.id) });
        res.end();
        return;
      }
      this.show(req, res, review);
    } catch (error) {
      if (error instanceof AuthError) return this.signIn(req, res, review, error.message);
      throw error;
    }
  }

  private newFlow(reviewId: string, challengeId: string, nonce: string, notice: string): LoginFlow {
    const flow = { reviewId, cookie: randomBytes(18).toString('base64url'), created: Date.now(), challengeId, nonce, notice };
    this.flows.set(flow.cookie, flow);
    return flow;
  }

  private flowFor(req: IncomingMessage, given: string | undefined, reviewId: string): LoginFlow | undefined {
    const fromCookie = cookieValue(req, FLOW_COOKIE);
    const flow = this.flows.get(fromCookie);
    if (!flow || flow.reviewId !== reviewId || given !== fromCookie || Date.now() - flow.created > FLOW_TTL_MS) return undefined;
    return flow;
  }

  flowCookie(flow: LoginFlow): string {
    return cookie(this.s.config.publicUrl, FLOW_COOKIE, flow.cookie, '/review', FLOW_TTL_MS / 1000);
  }
}
