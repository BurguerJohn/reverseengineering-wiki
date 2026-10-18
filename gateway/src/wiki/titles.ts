/** Namespaces and title rules (design/02-knowledge-model.md#namespaces). */

export const SUBJECT_TYPES = ['software', 'library', 'format', 'platform', 'technique', 'tool'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type PageType = SubjectType | 'build' | 'symbols' | 'fact' | 'code' | 'notes' | 'project' | 'other';
type NamespacedType = Exclude<PageType, 'project' | 'other' | 'symbols'>;

/** Symbol map pages live under their build: Build:<build>/symbols/<8 hex digits or more (64-bit addresses), chunk start>. */
export const SYMBOLS_TITLE = /^Build:(.+)\/symbols\/([0-9A-F]{8,16})$/;

export const NAMESPACES: Record<NamespacedType, { id: number; name: string }> = {
  software: { id: 3000, name: 'Software' },
  library: { id: 3002, name: 'Library' },
  format: { id: 3004, name: 'Format' },
  platform: { id: 3006, name: 'Platform' },
  technique: { id: 3008, name: 'Technique' },
  tool: { id: 3010, name: 'Tool' },
  build: { id: 3012, name: 'Build' },
  fact: { id: 3014, name: 'Fact' },
  code: { id: 3016, name: 'Code' },
  notes: { id: 3018, name: 'Notes' },
};

export const PROJECT_NS = 4;
export const CONTENT_NAMESPACE_IDS = Object.values(NAMESPACES).map((n) => n.id);
const BY_NAME = new Map(Object.entries(NAMESPACES).map(([type, ns]) => [ns.name.toLowerCase(), type as NamespacedType]));
const BY_ID = new Map(Object.entries(NAMESPACES).map(([type, ns]) => [ns.id, type as PageType]));

export function typeOfNamespace(id: number): PageType {
  if (id === PROJECT_NS) return 'project';
  return BY_ID.get(id) ?? 'other';
}

export class TitleError extends Error {}

const FORBIDDEN = /[#<>[\]|{}\u0000-\u001f\u007f]/;

/** Normalizes like MediaWiki: underscores→spaces, collapsed whitespace, first letter upper case. */
export function normalizeTitle(raw: string): string {
  let title = raw.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const colon = title.indexOf(':');
  if (colon > 0) {
    const ns = title.slice(0, colon).trim();
    const rest = title.slice(colon + 1).trim();
    const type = BY_NAME.get(ns.toLowerCase());
    if (type) {
      title = `${NAMESPACES[type].name}:${ucfirst(rest)}`;
    } else if (ns.toLowerCase() === 'rewiki' || ns.toLowerCase() === 'project') {
      title = `REWiki:${ucfirst(rest)}`;
    }
  } else {
    title = ucfirst(title);
  }
  return title;
}

function ucfirst(s: string): string {
  if (!s) return s;
  const first = String.fromCodePoint(s.codePointAt(0)!);
  return first.toUpperCase() + s.slice(first.length);
}

export function validateTitle(title: string): void {
  if (!title || title.length > 230) throw new TitleError('Title must be 1–230 characters');
  if (FORBIDDEN.test(title)) throw new TitleError('Title contains forbidden characters: # < > [ ] | { } or control characters');
  if (/(^|\/)\.\.?(\/|$)/.test(title) || title.includes('~~~')) throw new TitleError('Title contains a forbidden sequence');
}

export function typeOfTitle(title: string): PageType {
  const colon = title.indexOf(':');
  if (colon <= 0) return 'other';
  const ns = title.slice(0, colon).toLowerCase();
  if (ns === 'rewiki' || ns === 'project') return 'project';
  const type = BY_NAME.get(ns) ?? 'other';
  return type === 'build' && SYMBOLS_TITLE.test(title) ? 'symbols' : type;
}

/** "Software:Earth Defense Force 5" → "Earth Defense Force 5" */
export function baseName(title: string): string {
  const colon = title.indexOf(':');
  return colon > 0 ? title.slice(colon + 1) : title;
}

export function makeTitle(type: NamespacedType, name: string): string {
  const title = normalizeTitle(`${NAMESPACES[type].name}:${name}`);
  validateTitle(title);
  return title;
}

/** True when the text before the first colon is one of the wiki's namespaces. */
export function hasNamespace(raw: string): boolean {
  return typeOfTitle(normalizeTitle(raw)) !== 'other';
}

/**
 * Resolves a title the caller passed to one of the expected types. The namespace prefix is
 * optional: "Chrono Trigger" works where a Software: page is expected, and a colon that is
 * not a namespace is part of the name ("The Legend of Zelda: A Link to the Past"). When
 * several types are possible, `exists` picks the one page that exists.
 */
export function requireTitle(raw: string, allowed: readonly PageType[], exists: (title: string) => boolean = () => false): string {
  const title = normalizeTitle(raw);
  validateTitle(title);
  const type = typeOfTitle(title);
  if (allowed.includes(type)) return title;
  const prefixes = allowed.filter((t): t is NamespacedType => t in NAMESPACES);
  if (type !== 'other' || !prefixes.length) {
    throw new TitleError(`"${title}" is not a ${allowed.join('/')} page. Use a namespace prefix like ${prefixes.map((t) => `${NAMESPACES[t].name}:`).join(', ')}`);
  }
  const candidates = prefixes.map((t) => normalizeTitle(`${NAMESPACES[t].name}:${raw.trim()}`));
  for (const c of candidates) validateTitle(c);
  if (candidates.length === 1) return candidates[0];
  const existing = candidates.filter(exists);
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) throw new TitleError(`"${raw}" matches several pages: ${existing.join(', ')}. Pass the full title.`);
  throw new TitleError(`No page named "${raw.trim()}" exists yet. Create it first (create_page), or pass the full title with its namespace (${prefixes.map((t) => `${NAMESPACES[t].name}:`).join(', ')}).`);
}

/** Turns free text into something safe for a title segment (fact keys, code names). */
export function titleSegment(text: string, max = 80): string {
  return text.replace(/[#<>[\]|{}\u0000-\u001f\u007f/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export function pageUrl(publicUrl: string, title: string): string {
  return `${publicUrl}/index.php/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%3A/g, ':').replace(/%2F/g, '/')}`;
}

/** "Software:Earth Defense Force 5/Weapons" → "Software:Earth Defense Force 5" (subject pages only). */
export function subjectRoot(title: string): string {
  const slash = title.indexOf('/');
  return slash > 0 && (SUBJECT_TYPES as readonly string[]).includes(typeOfTitle(title)) ? title.slice(0, slash) : title;
}

/** True for a topic subpage of a subject, e.g. "Software:Earth Defense Force 5/Weapons". */
export function isTopicPage(title: string): boolean {
  return subjectRoot(title) !== title;
}

/** Size of one symbol map page in address space. */
export const SYMBOL_CHUNK = 0x40000;

/** Symbol map page holding an RVA: Build:<build>/symbols/<chunk start>. */
export function symbolsPageTitle(build: string, rva: number): string {
  const start = Math.floor(rva / SYMBOL_CHUNK) * SYMBOL_CHUNK;
  return `${build}/symbols/${start.toString(16).toUpperCase().padStart(8, '0')}`;
}
