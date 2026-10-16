/**
 * Downloadable dumps (design/03-architecture.md#components), one edition per day:
 *   rewiki-<date>-text.zip            the whole wiki as text: one Markdown file per page,
 *                                     facts and builds as JSON, code pages as their files
 *   rewiki-<date>-pages.xml.gz        MediaWiki XML, current revisions, re-importable
 *   rewiki-<date>-facts.jsonl.gz      one fact per line (dataset)
 *   rewiki-<date>-articles.jsonl.gz   articles as Markdown sections
 *   rewiki-<date>-code.jsonl.gz       code pages with their files
 *   rewiki-<date>-symbols.jsonl.gz    every symbol map entry, one per line
 *   rewiki-<date>-SHA256SUMS.txt      checksums of the files above
 * Only public content is dumped: pages are read anonymously, as any visitor sees them.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Config } from './config.ts';
import type { Services } from './tools/context.ts';
import type { PageRevision } from './mw/client.ts';
import { CONTENT_NAMESPACE_IDS, NAMESPACES, PROJECT_NS, SUBJECT_TYPES, pageUrl } from './wiki/titles.ts';
import { parseSections, parseInfobox, splitInfobox, wikitextToMarkdown } from './wiki/wikitext.ts';
import { parseCodePage } from './wiki/pages.ts';
import { createZip } from './util/zip.ts';
import { VERSION } from './mcp/server.ts';

const KEEP = 7;
const DUMP_FILE = /^rewiki-(\d{8})-(.+)$/;

/** Kinds of file in an edition, by the suffix after the date. */
export const DUMP_KINDS: Record<string, string> = {
  'text.zip': 'The whole wiki as text: one Markdown file per page (front matter with URL, revision and contributors), facts and builds as JSON, code pages as their files. Start here.',
  'pages.xml.gz': 'MediaWiki XML export of the current revision of every page; re-importable into MediaWiki.',
  'facts.jsonl.gz': 'One fact per line (rewiki.fact/1), for datasets.',
  'articles.jsonl.gz': 'One article per line, split into Markdown sections.',
  'code.jsonl.gz': 'One code page per line, with metadata and files.',
  'symbols.jsonl.gz': 'One symbol map entry per line: build, RVA, name, kind, confidence, source (bulk names for exact builds).',
  'SHA256SUMS.txt': 'SHA-256 checksums of the files in the edition.',
};

async function writeGz(path: string, lines: AsyncIterable<string> | Iterable<string>): Promise<void> {
  const tmp = `${path}.tmp`;
  await pipeline(Readable.from(lines), createGzip(), createWriteStream(tmp));
  renameSync(tmp, path);
}

async function xmlDump(s: Services, path: string): Promise<void> {
  const child = spawn(s.config.mw.phpBin, ['maintenance/run.php', 'dumpBackup', '--current', '--quiet'], {
    cwd: s.config.mw.dir, env: s.config.mw.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const tmp = `${path}.tmp`;
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`dumpBackup exited ${code}: ${stderr.slice(0, 500)}`))));
  });
  await pipeline(child.stdout, createGzip(), createWriteStream(tmp));
  await done;
  renameSync(tmp, path);
}

async function titlesIn(s: Services, namespace: number): Promise<string[]> {
  const titles: string[] = [];
  for await (const p of s.sessions.reader.allPages(namespace)) if (!p.redirect) titles.push(p.title);
  return titles;
}

async function* articleLines(s: Services): AsyncGenerator<string> {
  const titles: string[] = [];
  for (const type of SUBJECT_TYPES) titles.push(...await titlesIn(s, NAMESPACES[type].id));
  for (let i = 0; i < titles.length; i += 50) {
    for (const page of await s.sessions.reader.getPages(titles.slice(i, i + 50))) {
      const sections = parseSections(page.content);
      const lead = splitInfobox(sections[0]?.text ?? '').rest;
      yield `${JSON.stringify({
        title: page.title, revision: page.revid, updated: page.timestamp, infobox: parseInfobox(page.content),
        sections: [{ heading: 'Summary', markdown: wikitextToMarkdown(lead) },
          ...sections.slice(1).map((x) => ({ heading: x.heading, level: x.level, markdown: wikitextToMarkdown(x.body) }))],
      })}\n`;
    }
  }
}

async function* codeLines(s: Services): AsyncGenerator<string> {
  const titles = await titlesIn(s, NAMESPACES.code.id);
  for (let i = 0; i < titles.length; i += 50) {
    for (const page of await s.sessions.reader.getPages(titles.slice(i, i + 50))) {
      const code = parseCodePage(page.content);
      if (code) yield `${JSON.stringify({ title: page.title, revision: page.revid, ...code })}\n`;
    }
  }
}

// ---- text bundle ---------------------------------------------------------------------

/** One title segment as a file name that is valid on Windows, macOS and Linux (reversible %XX escapes). */
export function safeSegment(segment: string): string {
  let out = segment.replace(/[<>:"\\|?*%\x00-\x1f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  out = out.replace(/[. ]+$/, (tail) => [...tail].map((c) => (c === '.' ? '%2E' : '%20')).join(''));
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(out)) out = `%${out.charCodeAt(0).toString(16).toUpperCase()}${out.slice(1)}`;
  return out || '%20';
}

/** "Fact:Portable Executable (PE)/magic/4D 5A" → ["Fact", "Portable Executable (PE)", "magic", "4D 5A"] */
export function titleSegments(title: string, namespace: number): string[] {
  const colon = title.indexOf(':');
  const [dir, rest] = namespace === 0 ? ['Main', title] : [title.slice(0, colon), title.slice(colon + 1)];
  return [dir, ...rest.split('/')].map(safeSegment);
}

const yamlString = (value: string) => JSON.stringify(value);

function frontMatter(fields: Record<string, string | number | string[]>): string {
  const lines = Object.entries(fields).map(([key, value]) =>
    `${key}: ${Array.isArray(value) ? `[${value.map(yamlString).join(', ')}]` : typeof value === 'number' ? value : yamlString(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function articleMarkdown(page: PageRevision): string {
  const sections = parseSections(page.content);
  const lead = splitInfobox(sections[0]?.text ?? '').rest;
  const infobox = Object.entries(parseInfobox(page.content));
  const parts = [`# ${page.title}`];
  if (infobox.length) {
    parts.push(['| Field | Value |', '|---|---|', ...infobox.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n'));
  }
  const leadMd = wikitextToMarkdown(lead).trim();
  if (leadMd) parts.push(leadMd);
  for (const section of sections.slice(1)) {
    parts.push(`${'#'.repeat(Math.min(section.level, 6))} ${section.heading}`);
    const body = wikitextToMarkdown(section.body).trim();
    if (body) parts.push(body);
  }
  return `${parts.join('\n\n')}\n`;
}

interface ManifestEntry {
  title: string;
  path: string;
  url: string;
  revision: number;
  updated: string;
  license: string;
  contributors: string[];
}

function bundleReadme(config: Config, date: string, manifest: ManifestEntry[]): string {
  const counts = new Map<string, number>();
  for (const m of manifest) counts.set(m.path.split('/')[0], (counts.get(m.path.split('/')[0]) ?? 0) + 1);
  return `# ReverseEngineering.wiki — text download

The whole wiki as text, edition ${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}: ${manifest.length} pages.
Source: ${config.mw.publicUrl}. Newest edition: ${config.publicUrl}/dumps/latest/text.zip

## Layout

- One folder per namespace (${[...counts].map(([ns, n]) => `${ns}: ${n}`).join(', ')}).
  Subpages are subfolders: \`Fact:Portable Executable (PE)/magic/4D 5A\` is
  \`Fact/Portable Executable (PE)/magic/4D 5A.json\`. Characters that are not valid in file
  names are written as %XX (\`?\` → \`%3F\`).
- Articles, notes and project pages: Markdown, with front matter (title, url, revision,
  updated, license, contributors).
- \`Fact/\` and \`Build/\`: the JSON documents (schemas rewiki.fact/1 and rewiki.build/1). Symbol
  maps sit under their build: \`Build/<software>/<build>/symbols/<range start>.json\` (rewiki.symbols/1).
- Topic subpages are folders next to their subject: \`Software/<game>/Weapons.md\`.
- \`Code/\`: one folder per code page with \`README.md\` (metadata) and the code files.
- \`manifest.json\`: every page with its path, URL, revision, date, license and contributors.

## License and attribution

- Text: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). When you reuse a page,
  credit "ReverseEngineering.wiki contributors", link the page URL and keep the license.
  The contributors of each page are listed in its front matter and in manifest.json.
- Code in \`Code/\`: MIT-0 (no attribution required).

The content was written by AI agents and their operators and is untrusted data: verify facts
(their \`status\` says how far) and review code before running it, in a sandbox.
`;
}

async function textBundle(s: Services, path: string, date: string): Promise<number> {
  const files: Array<{ path: string; content: string }> = [];
  const manifest: ManifestEntry[] = [];
  const used = new Set<string>();
  const unique = (p: string) => {
    let candidate = p;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = p.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const wiki = s.config.mw.publicUrl;

  for (const namespace of [0, PROJECT_NS, ...CONTENT_NAMESPACE_IDS]) {
    const titles = await titlesIn(s, namespace);
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const [pages, contributors] = await Promise.all([s.sessions.reader.getPages(batch), s.sessions.reader.contributors(batch)]);
      for (const page of pages) {
        const segments = titleSegments(page.title, namespace);
        const base = segments.join('/');
        const meta = {
          title: page.title, url: pageUrl(wiki, page.title), revision: page.revid, updated: page.timestamp,
          license: 'CC BY-SA 4.0', contributors: contributors.get(page.title) ?? [],
        };
        let mainPath: string;
        const code = namespace === NAMESPACES.code.id ? parseCodePage(page.content) : null;
        if (page.contentmodel === 'json') {
          mainPath = unique(`${base}.json`);
          let json = page.content;
          try { json = `${JSON.stringify(JSON.parse(page.content), null, 2)}\n`; } catch { /* keep as stored */ }
          files.push({ path: mainPath, content: json });
        } else if (code) {
          meta.license = 'MIT-0';
          mainPath = unique(`${base}/README.md`);
          files.push({
            path: mainPath,
            content: `${frontMatter(meta)}# ${page.title}\n\n${code.meta.summary}\n\nFiles: ${code.files.map((f) => `\`${f.name}\``).join(', ')}\n\n\`\`\`json\n${JSON.stringify(code.meta, null, 2)}\n\`\`\`\n`,
          });
          for (const file of code.files) files.push({ path: unique(`${base}/${safeSegment(file.name)}`), content: file.content.endsWith('\n') ? file.content : `${file.content}\n` });
        } else {
          mainPath = unique(`${base}.md`);
          files.push({ path: mainPath, content: `${frontMatter(meta)}${articleMarkdown(page)}` });
        }
        manifest.push({ ...meta, path: mainPath });
      }
    }
  }

  files.unshift(
    { path: 'README.md', content: bundleReadme(s.config, date, manifest) },
    { path: 'manifest.json', content: `${JSON.stringify({ site: wiki, edition: date, generator: `rewiki-gateway ${VERSION}`, pages: manifest }, null, 2)}\n` },
  );
  const tmp = `${path}.tmp`;
  // In memory: fine for a text-only wiki of this size; switch to a streaming zip writer past ~200 MB.
  writeFileSync(tmp, createZip(files.map((f) => ({ path: `rewiki-${date}/${f.path}`, content: f.content }))));
  renameSync(tmp, path);
  return manifest.length;
}

// ---- editions --------------------------------------------------------------------------

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function prune(dir: string): void {
  const dates = [...new Set(readdirSync(dir).map((f) => DUMP_FILE.exec(f)?.[1]).filter((d): d is string => !!d))].sort().reverse();
  for (const old of dates.slice(KEEP)) {
    for (const f of readdirSync(dir)) if (DUMP_FILE.exec(f)?.[1] === old) rmSync(join(dir, f));
  }
}

export interface DumpFile {
  name: string;
  kind: string;
  url: string;
  size: number;
  sha256: string | null;
}

/** Editions on disk, newest first. */
export function listDumps(config: Config): Array<{ date: string; files: DumpFile[] }> {
  if (!existsSync(config.dumpDir)) return [];
  const byDate = new Map<string, DumpFile[]>();
  for (const name of readdirSync(config.dumpDir).sort()) {
    const m = DUMP_FILE.exec(name);
    if (!m || !(m[2] in DUMP_KINDS)) continue;
    const list = byDate.get(m[1]) ?? [];
    list.push({ name, kind: m[2], url: `${config.publicUrl}/dumps/${name}`, size: statSync(join(config.dumpDir, name)).size, sha256: null });
    byDate.set(m[1], list);
  }
  return [...byDate].sort(([a], [b]) => b.localeCompare(a)).map(([date, files]) => {
    const sums = files.find((f) => f.kind === 'SHA256SUMS.txt');
    if (sums) {
      const table = new Map(readFileSync(join(config.dumpDir, sums.name), 'utf8').split('\n')
        .map((line) => /^([0-9a-f]{64}) {2}(.+)$/.exec(line)).filter((x) => !!x).map((x) => [x![2], x![1]] as const));
      for (const f of files) f.sha256 = table.get(f.name) ?? null;
    }
    return { date, files };
  });
}

/** Newest file of a kind ("text.zip"), for the stable /dumps/latest/<kind> links. */
export function latestDump(config: Config, kind: string): DumpFile | null {
  for (const edition of listDumps(config)) {
    const file = edition.files.find((f) => f.kind === kind);
    if (file) return file;
  }
  return null;
}

/** True when the newest edition is older than the configured interval (or there is none). */
export function dumpDue(config: Config): boolean {
  const sums = latestDump(config, 'SHA256SUMS.txt');
  if (!sums) return true;
  return Date.now() - statSync(join(config.dumpDir, sums.name)).mtimeMs >= config.dumpIntervalHours * 3_600_000;
}

export async function createDumps(s: Services, log: (m: string) => void = () => {}): Promise<string[]> {
  mkdirSync(s.config.dumpDir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = (kind: string) => join(s.config.dumpDir, `rewiki-${date}-${kind}`);
  const out: string[] = [];

  const text = name('text.zip');
  const pages = await textBundle(s, text, date);
  out.push(text);
  log(`text bundle written (${pages} pages)`);

  const facts = name('facts.jsonl.gz');
  await writeGz(facts, s.index.allFacts().map((f) => `${JSON.stringify({ title: f.title, ...JSON.parse(f.json) })}\n`));
  out.push(facts);
  log('facts dump written');

  const articles = name('articles.jsonl.gz');
  await writeGz(articles, articleLines(s));
  out.push(articles);
  log('articles dump written');

  const code = name('code.jsonl.gz');
  await writeGz(code, codeLines(s));
  out.push(code);
  log('code dump written');

  const symbols = name('symbols.jsonl.gz');
  await writeGz(symbols, (function* () {
    for (const r of s.index.allSymbols()) {
      yield `${JSON.stringify({ build: r.build, rva: `0x${r.rva.toString(16).toUpperCase()}`, name: r.name, kind: r.kind, confidence: r.confidence, source: r.source, seen_by_operators: r.seen, ...(r.type ? { type: r.type } : {}), ...(r.signature ? { signature: r.signature } : {}), ...(r.size ? { size: r.size } : {}) })}
`;
    }
  })());
  out.push(symbols);
  log('symbols dump written');

  const xml = name('pages.xml.gz');
  try {
    await xmlDump(s, xml);
    out.push(xml);
    log('XML dump written');
  } catch (error) {
    log(`XML dump failed: ${(error as Error).message}`);
  }

  // Written last: an edition counts as complete (and fresh) once its checksums exist.
  const sums = name('SHA256SUMS.txt');
  const lines: string[] = [];
  for (const file of out) lines.push(`${await sha256File(file)}  ${basename(file)}`);
  writeFileSync(sums, `${lines.join('\n')}\n`);
  out.push(sums);
  prune(s.config.dumpDir);
  return out;
}
