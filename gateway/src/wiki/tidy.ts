/**
 * Tidies an article's sections (CLI: tidy-pages): merges sections whose headings only
 * differ by entities or case (the old "&amp;" bug), drops empty placeholder sections and
 * the old Facts / Code list sections (the infobox links those now), and keeps every line
 * of real content. Pure: returns the new text and what changed.
 */
import { EMPTY } from './pages.ts';
import { headingKey, joinSections, parseSections, type Section } from './wikitext.ts';

const LIST_TEMPLATE = /^\{\{(?:Fact list|Code list)\|[^}]*\}\}$/;

function meaningfulLines(body: string): string[] {
  return body.split('\n').filter((line) => line.trim() && line.trim() !== EMPTY && !LIST_TEMPLATE.test(line.trim()));
}

export function tidyArticle(wikitext: string): { text: string; changes: string[] } {
  const sections = parseSections(wikitext);
  const changes: string[] = [];
  const out: Section[] = [];
  const firstByKey = new Map<string, Section>();
  for (const section of sections) {
    if (section.level === 0) {
      out.push(section);
      continue;
    }
    const key = `${section.level}:${headingKey(section.heading)}`;
    const lines = meaningfulLines(section.body);
    const first = firstByKey.get(key);
    if (first) {
      // Same heading again: move its content into the first occurrence.
      if (lines.length) {
        const merged = [...meaningfulLines(first.body), ...lines].join('\n');
        first.body = merged;
        first.text = `${first.text.split('\n')[0]}\n${merged}`;
      }
      changes.push(`merged duplicate "${section.heading}"`);
      continue;
    }
    const kept = { ...section };
    if (lines.length !== section.body.split('\n').filter((l) => l.trim()).length) {
      kept.body = lines.join('\n');
      kept.text = `${section.text.split('\n')[0]}\n${kept.body}`;
    }
    firstByKey.set(key, kept);
    out.push(kept);
  }
  // Drop sections left empty, unless a subsection follows (it still needs its parent).
  const result = out.filter((section, i) => {
    if (section.level === 0 || meaningfulLines(section.body).length) return true;
    const next = out[i + 1];
    if (next && next.level > section.level) return true;
    changes.push(`removed empty "${section.heading}"`);
    return false;
  });
  // Decode entity-only headings ("Engine &amp; libraries used" → "Engine & libraries used").
  for (const section of result) {
    if (section.level > 0 && /&amp;/.test(section.text.split('\n')[0])) {
      const [head, ...rest] = section.text.split('\n');
      section.text = [head.replace(/&amp;/g, '&'), ...rest].join('\n');
      changes.push(`fixed heading "${section.heading}"`);
    }
  }
  return { text: joinSections(result.map((s, index) => ({ ...s, index }))), changes };
}
