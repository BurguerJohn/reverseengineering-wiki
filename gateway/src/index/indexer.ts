/** Keeps the search index in sync with MediaWiki by polling recent changes. */
import type { MwClient } from '../mw/client.ts';
import type { SearchIndex } from './index.ts';
import { CONTENT_NAMESPACE_IDS, PROJECT_NS } from '../wiki/titles.ts';

const INDEXED_NAMESPACES = [...CONTENT_NAMESPACE_IDS, PROJECT_NS];
const CURSOR = 'rc_cursor';

export class Indexer {
  private readonly mw: MwClient;
  private readonly index: SearchIndex;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(mw: MwClient, index: SearchIndex) {
    this.mw = mw;
    this.index = index;
  }

  async rebuild(log: (msg: string) => void = () => {}): Promise<number> {
    const started = new Date().toISOString();
    this.index.clear();
    let count = 0;
    for (const ns of INDEXED_NAMESPACES) {
      const titles: string[] = [];
      for await (const page of this.mw.allPages(ns)) titles.push(page.title);
      for (const page of await this.mw.getPages(titles)) {
        this.index.indexPage(page);
        count++;
      }
      if (titles.length) log(`namespace ${ns}: ${titles.length} pages`);
    }
    this.index.setState(CURSOR, started);
    return count;
  }

  /** Reindexes specific titles right away (used after the gateway's own edits). */
  async refresh(titles: string[]): Promise<void> {
    const unique = [...new Set(titles)];
    const pages = await this.mw.getPages(unique);
    const found = new Set(pages.map((p) => p.title));
    for (const page of pages) this.index.indexPage(page);
    for (const title of unique) if (!found.has(title)) this.index.removePage(title);
  }

  async poll(): Promise<number> {
    const cursor = this.index.getState(CURSOR);
    if (!cursor) return this.rebuild();
    const changes = await this.mw.recentChanges({ start: cursor, namespaces: INDEXED_NAMESPACES, limit: 2000 });
    if (!changes.length) return 0;
    const touched = new Set<string>();
    for (const change of changes) {
      touched.add(change.title);
      const target = change.logparams?.target_title;
      if (change.type === 'log' && typeof target === 'string') touched.add(target);
    }
    await this.refresh([...touched]);
    this.index.setState(CURSOR, changes[changes.length - 1].timestamp);
    return touched.size;
  }

  start(intervalSeconds: number, onError: (error: unknown) => void): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.poll();
      } catch (error) {
        onError(error);
      } finally {
        this.running = false;
      }
    };
    void tick();
    this.timer = setInterval(tick, Math.max(1, intervalSeconds) * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
