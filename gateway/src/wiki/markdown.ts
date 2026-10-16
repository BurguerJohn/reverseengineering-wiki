/**
 * Markdown → wikitext. Agents write Markdown; MediaWiki stores wikitext.
 * Supported: headings, paragraphs, emphasis, strikethrough, inline code,
 * fenced/indented code, lists (nested), GFM tables, blockquotes, rules,
 * links, and [[Wiki links]] passed through. Raw HTML is escaped.
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false });

type Token = ReturnType<typeof md.parse>[number];

const WIKILINK = /\[\[[^[\]{}|<>\n]+(?:\|[^[\]{}<>\n]*)?\]\]/g;

/** Escapes wikitext syntax in plain text, keeping [[Wiki links]] intact. */
export function escapeText(text: string, inTable = false): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    out += escapePlain(text.slice(last, m.index), inTable) + m[0];
    last = (m.index ?? 0) + m[0].length;
  }
  return out + escapePlain(text.slice(last), inTable);
}

function escapePlain(text: string, inTable: boolean): string {
  let s = text
    // A lone & is plain text in MediaWiki; only one that would start an entity needs escaping.
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/''/g, '&#39;&#39;')
    .replace(/~~~/g, '&#126;&#126;&#126;')
    .replace(/__/g, '&#95;&#95;');
  if (inTable) s = s.replace(/\|/g, '&#124;').replace(/!!/g, '&#33;&#33;');
  return s;
}

function lineStartSafe(line: string): string {
  return /^[*#:;= {|!-]/.test(line) ? `<nowiki/>${line}` : line;
}

function sanitizeLang(info: string): string {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9+#._-]{1,30}$/.test(lang) ? lang : 'text';
}

export function codeBlock(lang: string, content: string): string {
  const body = content.replace(/\n$/, '').replace(/<\/syntaxhighlight/gi, '&lt;/syntaxhighlight');
  return `<syntaxhighlight lang="${sanitizeLang(lang)}">\n${body}\n</syntaxhighlight>`;
}

function renderInline(tokens: Token[], inTable = false): string {
  let out = '';
  let linkHref: string | null = null;
  let linkText = '';
  const emit = (s: string) => {
    if (linkHref !== null) linkText += s;
    else out += s;
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        emit(escapeText(t.content, inTable));
        break;
      case 'strong_open':
      case 'strong_close':
        emit("'''");
        break;
      case 'em_open':
      case 'em_close':
        emit("''");
        break;
      case 's_open':
        emit('<s>');
        break;
      case 's_close':
        emit('</s>');
        break;
      case 'code_inline':
        emit(`<code><nowiki>${t.content.replace(/<\/nowiki>/gi, '&lt;/nowiki>')}</nowiki></code>`);
        break;
      case 'softbreak':
        emit(' ');
        break;
      case 'hardbreak':
        emit('<br />');
        break;
      case 'link_open':
        linkHref = String(t.attrGet('href') ?? '');
        linkText = '';
        break;
      case 'link_close': {
        const href = linkHref ?? '';
        const text = linkText || escapeText(href, inTable);
        linkHref = null;
        if (/^https?:\/\//i.test(href)) out += `[${href.replace(/ /g, '%20').replace(/]/g, '%5D')} ${text}]`;
        else if (href.startsWith('#')) out += `[[${href}|${text}]]`;
        else out += text;
        break;
      }
      case 'image':
        emit(escapeText(t.content || String(t.attrGet('src') ?? ''), inTable));
        break;
      case 'html_inline':
        emit(escapeText(t.content, inTable));
        break;
      default:
        if (t.children) emit(renderInline(t.children, inTable));
        else if (t.content) emit(escapeText(t.content, inTable));
    }
  }
  return out;
}

/**
 * @param opts.topLevel wikitext heading level (2–6) that the shallowest Markdown
 *   heading maps to. Agents write "## Section" for top-level sections, so bodies
 *   are normalized; without it, levels map one to one ("##" ↔ "=="), as wikitextToMarkdown reads them back.
 */
export function markdownToWikitext(markdown: string, opts: { topLevel?: number } = {}): string {
  const tokens = md.parse(markdown.replace(/\r\n?/g, '\n'), {});
  const levels = tokens.filter((t) => t.type === 'heading_open').map((t) => Number(t.tag.slice(1)));
  const shift = opts.topLevel !== undefined && levels.length ? opts.topLevel - Math.min(...levels) : 0;
  const out: string[] = [];
  const listStack: string[] = [];
  let listLines: string[] = [];
  let itemBuffer: string[] | null = null;
  const quoteStack: string[][] = [];
  let table: { rows: Array<{ header: boolean; cells: string[] }>; current: string[] | null; header: boolean } | null = null;

  const push = (block: string) => {
    if (itemBuffer) itemBuffer.push(block);
    else if (quoteStack.length) quoteStack[quoteStack.length - 1].push(block);
    else out.push(block);
  };
  const flushItem = () => {
    if (!itemBuffer) return;
    const [first = '', ...rest] = itemBuffer;
    let line = `${listStack.join('')} ${first}`;
    // A code block can't live inside a wikitext list item; it follows the item.
    for (const b of rest) line += b.startsWith('<syntaxhighlight') ? `\n${b}` : `<br />${b}`;
    itemBuffer = null;
    listLines.push(line);
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t.type) {
      case 'heading_open': {
        const level = Math.max(2, Math.min(Number(t.tag.slice(1)) + shift, 6));
        const inline = tokens[i + 1];
        const eq = '='.repeat(level);
        push(`${eq} ${renderInline(inline.children ?? []).trim()} ${eq}`);
        i += 2;
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const text = renderInline(inline.children ?? []).trim();
        push(itemBuffer ? text : lineStartSafe(text));
        i += 2;
        break;
      }
      case 'fence':
      case 'code_block':
        push(codeBlock(t.type === 'fence' ? t.info : 'text', t.content));
        break;
      case 'hr':
        push('----');
        break;
      case 'bullet_list_open':
      case 'ordered_list_open':
        // Nested list: the parent item's line is emitted first, children follow.
        flushItem();
        listStack.push(t.type === 'bullet_list_open' ? '*' : '#');
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        flushItem();
        listStack.pop();
        if (!listStack.length) {
          // One block: blank lines between items would split (and renumber) the list.
          const lines = listLines;
          listLines = [];
          push(lines.join('\n'));
        }
        break;
      case 'list_item_open':
        flushItem();
        itemBuffer = [];
        break;
      case 'list_item_close':
        flushItem();
        break;
      case 'blockquote_open':
        quoteStack.push([]);
        break;
      case 'blockquote_close': {
        const inner = quoteStack.pop() ?? [];
        push(`<blockquote>\n${inner.join('\n\n')}\n</blockquote>`);
        break;
      }
      case 'table_open':
        table = { rows: [], current: null, header: false };
        break;
      case 'thead_open':
        if (table) table.header = true;
        break;
      case 'thead_close':
        if (table) table.header = false;
        break;
      case 'tr_open':
        if (table) table.current = [];
        break;
      case 'tr_close':
        if (table?.current) table.rows.push({ header: table.header, cells: table.current });
        if (table) table.current = null;
        break;
      case 'th_open':
      case 'td_open': {
        const inline = tokens[i + 1];
        table?.current?.push(renderInline(inline.children ?? [], true).trim());
        i += 2;
        break;
      }
      case 'table_close': {
        if (!table) break;
        const lines = ['{| class="wikitable"'];
        table.rows.forEach((row, index) => {
          if (index > 0) lines.push('|-');
          lines.push(row.header ? `! ${row.cells.join(' !! ')}` : `| ${row.cells.join(' || ')}`);
        });
        lines.push('|}');
        push(lines.join('\n'));
        table = null;
        break;
      }
      case 'html_block':
        push(lineStartSafe(escapeText(t.content.trim())));
        break;
      default:
        break;
    }
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}
