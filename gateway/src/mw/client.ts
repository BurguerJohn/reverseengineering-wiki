/**
 * Minimal MediaWiki Action API client. One instance = one logged-in session
 * (cookie jar). The gateway keeps one session for its service account and one
 * per operator account.
 */

export class MwError extends Error {
  readonly code: string;
  constructor(code: string, info: string) {
    super(`${code}: ${info}`);
    this.code = code;
  }
}

export interface PageRevision {
  exists: true;
  title: string;
  pageid: number;
  revid: number;
  parentid: number;
  timestamp: string;
  user: string;
  comment: string;
  content: string;
  contentmodel: string;
  redirect: boolean;
}

export interface RevisionMeta {
  revid: number;
  parentid: number;
  timestamp: string;
  user: string;
  comment: string;
  size: number;
  tags: string[];
}

export interface RecentChange {
  type: string;
  ns: number;
  title: string;
  pageid: number;
  revid: number;
  old_revid: number;
  rcid: number;
  timestamp: string;
  user?: string;
  comment?: string;
  tags?: string[];
  patrolled?: boolean;
  unpatrolled?: boolean;
  autopatrolled?: boolean;
  logtype?: string;
  logaction?: string;
  logparams?: Record<string, unknown>;
  oldlen?: number;
  newlen?: number;
}

export interface EditParams {
  title: string;
  text?: string;
  summary: string;
  baserevid?: number;
  createonly?: boolean;
  nocreate?: boolean;
  tags?: string[];
  undo?: number;
  undoafter?: number;
  contentmodel?: string;
}

export interface EditResult {
  newrevid?: number;
  oldrevid?: number;
  nochange?: boolean;
  title: string;
}

export class MwClient {
  private readonly cookies = new Map<string, string>();
  private readonly tokens = new Map<string, string>();
  private loggedInAs: string | null = null;
  private credentials: { username: string; password: string } | null = null;
  private readonly apiUrl: string;
  private readonly publicUrl: string;
  private readonly userAgent: string;

  constructor(apiUrl: string, publicUrl: string, userAgent = 'REWikiGateway/0.1') {
    this.apiUrl = apiUrl;
    this.publicUrl = publicUrl;
    this.userAgent = userAgent;
  }

  get user(): string | null {
    return this.loggedInAs;
  }

  // ---- transport -----------------------------------------------------------

  async call<T = any>(params: Record<string, string | number | boolean | undefined>, post = false): Promise<T> {
    const body = new URLSearchParams();
    body.set('format', 'json');
    body.set('formatversion', '2');
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === false) continue;
      body.set(key, value === true ? '1' : String(value));
    }
    const headers: Record<string, string> = { 'User-Agent': this.userAgent };
    if (this.cookies.size) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let response: Response;
    if (post) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      response = await fetch(this.apiUrl, { method: 'POST', headers, body });
    } else {
      // A kept-alive connection the web server closed between requests fails with "other side closed": a read
      // is safe to repeat (writes are POSTs and never retried here, they may have been applied).
      for (let attempt = 0; ; attempt++) {
        try {
          response = await fetch(`${this.apiUrl}?${body}`, { headers });
          break;
        } catch (error) {
          if (attempt >= 2 || !(error instanceof TypeError)) throw error;
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === 'deleted' || /expires=Thu, 01[- ]Jan[- ]1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    if (!response.ok) throw new MwError('http', `HTTP ${response.status} from MediaWiki`);
    const data = (await response.json()) as any;
    if (data.error) throw new MwError(data.error.code, data.error.info ?? '');
    return data as T;
  }

  async token(type: 'csrf' | 'login' | 'createaccount' | 'patrol' | 'userrights' = 'csrf'): Promise<string> {
    const cached = this.tokens.get(type);
    if (cached) return cached;
    const data = await this.call({ action: 'query', meta: 'tokens', type });
    const token = data.query.tokens[`${type}token`] as string;
    if (type !== 'login') this.tokens.set(type, token);
    return token;
  }

  /** Retries once with a fresh token / session when the token went stale. */
  private async withToken<T>(type: 'csrf' | 'createaccount' | 'patrol' | 'userrights', fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.token(type));
    } catch (error) {
      if (error instanceof MwError && (error.code === 'badtoken' || error.code === 'assertuserfailed')) {
        this.tokens.clear();
        if (this.credentials) await this.login(this.credentials.username, this.credentials.password);
        return fn(await this.token(type));
      }
      throw error;
    }
  }

  // ---- session -------------------------------------------------------------

  async login(username: string, password: string): Promise<void> {
    this.cookies.clear();
    this.tokens.clear();
    const logintoken = await this.token('login');
    const data = await this.call({
      action: 'clientlogin', username, password, logintoken, loginreturnurl: this.publicUrl, rememberMe: true,
    }, true);
    if (data.clientlogin?.status !== 'PASS') {
      throw new MwError('loginfailed', data.clientlogin?.message ?? 'login failed');
    }
    this.credentials = { username, password };
    this.loggedInAs = data.clientlogin.username;
  }

  // ---- reads ---------------------------------------------------------------

  async getPage(title: string): Promise<PageRevision | { exists: false; title: string }> {
    const data = await this.call({
      action: 'query', prop: 'revisions|info', titles: title, rvslots: 'main',
      rvprop: 'ids|timestamp|user|comment|content|contentmodel',
    });
    return toPage(data.query.pages[0]);
  }

  /** Current revision of up to 50 pages per request. Missing pages are omitted. */
  async getPages(titles: string[]): Promise<PageRevision[]> {
    const out: PageRevision[] = [];
    for (let i = 0; i < titles.length; i += 50) {
      const data = await this.call({
        action: 'query', prop: 'revisions|info', titles: titles.slice(i, i + 50).join('|'), rvslots: 'main',
        rvprop: 'ids|timestamp|user|comment|content|contentmodel',
      }, true);
      for (const page of data.query.pages ?? []) {
        const p = toPage(page);
        if (p.exists) out.push(p);
      }
    }
    return out;
  }

  async getRevision(revid: number): Promise<PageRevision | null> {
    const data = await this.call({
      action: 'query', prop: 'revisions|info', revids: revid, rvslots: 'main',
      rvprop: 'ids|timestamp|user|comment|content|contentmodel',
    });
    const page = data.query.pages?.[0];
    if (!page || page.missing || !page.revisions) return null;
    return toPage(page) as PageRevision;
  }

  async history(title: string, limit = 20): Promise<RevisionMeta[]> {
    const data = await this.call({
      action: 'query', prop: 'revisions', titles: title, rvlimit: Math.min(limit, 500),
      rvprop: 'ids|timestamp|user|comment|size|tags',
    });
    const page = data.query.pages[0];
    return (page.revisions ?? []).map((r: any) => ({
      revid: r.revid, parentid: r.parentid, timestamp: r.timestamp, user: r.user ?? '(hidden)',
      comment: r.comment ?? '', size: r.size, tags: r.tags ?? [],
    }));
  }

  /** `patrolled` needs the patrol or patrolmarks right (the gateway session has it; anonymous does not). */
  async recentChanges(opts: {
    start?: string; namespaces?: number[]; limit?: number; title?: string; dir?: 'newer' | 'older'; patrolled?: boolean; user?: string;
  }): Promise<RecentChange[]> {
    const out: RecentChange[] = [];
    let cont: Record<string, string> = {};
    const want = opts.limit ?? 500;
    while (out.length < want) {
      const data = await this.call({
        action: 'query', list: 'recentchanges', rcdir: opts.dir ?? 'newer', rcstart: opts.start,
        rcnamespace: opts.namespaces?.join('|'), rctitle: opts.title, rcuser: opts.user,
        rcprop: `title|ids|timestamp|user|comment|tags|loginfo|sizes|redirect${opts.patrolled ? '|patrolled' : ''}`,
        rctype: 'edit|new|log', rclimit: Math.min(want - out.length, 500), ...cont,
      });
      out.push(...data.query.recentchanges);
      if (!data.continue) break;
      cont = data.continue;
    }
    return out;
  }

  /** Every page move (old title → new title), oldest first. */
  async *moveLog(): AsyncGenerator<{ from: string; to: string }> {
    let cont: Record<string, string> = {};
    for (;;) {
      const data = await this.call({ action: 'query', list: 'logevents', letype: 'move', ledir: 'newer', lelimit: 'max', leprop: 'title|details', ...cont });
      for (const e of data.query?.logevents ?? []) if (e.title && e.params?.target_title) yield { from: e.title, to: e.params.target_title };
      if (!data.continue) return;
      cont = data.continue;
    }
  }

  /** Usernames that edited each page (for CC BY-SA attribution), in MediaWiki's order. */
  async contributors(titles: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < titles.length; i += 50) {
      let cont: Record<string, string> = {};
      for (;;) {
        const data = await this.call({ action: 'query', prop: 'contributors', pclimit: 'max', titles: titles.slice(i, i + 50).join('|'), ...cont });
        for (const page of data.query?.pages ?? []) {
          const names = out.get(page.title) ?? [];
          for (const c of page.contributors ?? []) names.push(c.name);
          out.set(page.title, names);
        }
        if (!data.continue) break;
        cont = data.continue;
      }
    }
    return out;
  }

  async *allPages(namespace: number): AsyncGenerator<{ title: string; redirect: boolean }> {
    let cont: Record<string, string> = {};
    for (;;) {
      const data = await this.call({
        action: 'query', generator: 'allpages', gapnamespace: namespace, gaplimit: 'max', prop: 'info', ...cont,
      });
      for (const page of data.query?.pages ?? []) yield { title: page.title, redirect: !!page.redirect };
      if (!data.continue) return;
      cont = data.continue;
    }
  }

  async usersExist(names: string[]): Promise<Map<string, boolean>> {
    const data = await this.call({ action: 'query', list: 'users', ususers: names.join('|') });
    const map = new Map<string, boolean>();
    for (const user of data.query.users) map.set(user.name, !user.missing && !user.invalid);
    return map;
  }

  async userGroups(name: string): Promise<string[]> {
    const data = await this.call({ action: 'query', list: 'users', ususers: name, usprop: 'groups' });
    return data.query.users[0]?.groups ?? [];
  }

  async search(query: string, namespaces: number[], limit = 10): Promise<Array<{ title: string; snippet: string }>> {
    const data = await this.call({
      action: 'query', list: 'search', srsearch: query, srnamespace: namespaces.join('|'), srlimit: limit,
      srprop: 'snippet',
    });
    return data.query.search.map((s: any) => ({ title: s.title, snippet: stripHtml(s.snippet) }));
  }

  // ---- writes --------------------------------------------------------------

  async edit(params: EditParams): Promise<EditResult> {
    return this.withToken('csrf', async (token) => {
      const data = await this.call({
        action: 'edit', title: params.title, text: params.text, summary: params.summary,
        baserevid: params.baserevid, createonly: params.createonly, nocreate: params.nocreate,
        tags: params.tags?.join('|'), undo: params.undo, undoafter: params.undoafter,
        contentmodel: params.contentmodel, assert: this.loggedInAs ? 'user' : undefined, token,
      }, true);
      const edit = data.edit;
      if (edit.result !== 'Success') {
        throw new MwError(edit.code ?? 'editfailed', edit.info ?? JSON.stringify(edit));
      }
      return { newrevid: edit.newrevid, oldrevid: edit.oldrevid, nochange: !!edit.nochange, title: edit.title };
    });
  }

  async createAccount(username: string, password: string): Promise<void> {
    await this.withToken('createaccount', async (createtoken) => {
      const data = await this.call({
        action: 'createaccount', username, password, retype: password, createtoken,
        createreturnurl: this.publicUrl,
      }, true);
      if (data.createaccount?.status !== 'PASS') {
        throw new MwError(data.createaccount?.messagecode ?? 'createaccountfailed', data.createaccount?.message ?? '');
      }
    });
  }

  async userRights(user: string, add: string[], remove: string[], reason: string): Promise<void> {
    await this.withToken('userrights', (token) => this.call({
      action: 'userrights', user, add: add.join('|') || undefined, remove: remove.join('|') || undefined, reason, token,
    }, true));
  }

  async protect(title: string, level: string, expiry: string, reason: string): Promise<void> {
    await this.withToken('csrf', (token) => this.call({
      action: 'protect', title, protections: `edit=${level}|move=${level}`, expiry: `${expiry}|${expiry}`, reason, token,
    }, true));
  }

  async patrol(revid: number, tags?: string[]): Promise<void> {
    await this.withToken('patrol', (token) => this.call({ action: 'patrol', revid, tags: tags?.join('|'), token }, true));
  }

  async block(user: string, reason: string): Promise<void> {
    await this.withToken('csrf', (token) => this.call({
      action: 'block', user, reason, expiry: 'infinite', nocreate: true, autoblock: false, token,
    }, true));
  }

  async createTag(tag: string, reason: string): Promise<void> {
    try {
      await this.withToken('csrf', (token) => this.call({ action: 'managetags', operation: 'create', tag, reason, token }, true));
    } catch (error) {
      if (!(error instanceof MwError) || error.code !== 'tags-create-already-exists') throw error;
    }
  }
}

function toPage(page: any): PageRevision | { exists: false; title: string } {
  if (!page || page.missing || page.invalid || !page.revisions?.length) return { exists: false, title: page?.title ?? '' };
  const rev = page.revisions[0];
  return {
    exists: true,
    title: page.title,
    pageid: page.pageid,
    revid: rev.revid,
    parentid: rev.parentid,
    timestamp: rev.timestamp,
    user: rev.user ?? '(hidden)',
    comment: rev.comment ?? '',
    content: rev.slots?.main?.content ?? '',
    contentmodel: rev.slots?.main?.contentmodel ?? 'wikitext',
    redirect: !!page.redirect,
  };
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
