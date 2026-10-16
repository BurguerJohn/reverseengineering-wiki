import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToWikitext, escapeText } from '../src/wiki/markdown.ts';
import {
  parseSections, joinSections, replaceSectionBody, parseInfobox, renderInfobox, wikitextToMarkdown, findSection,
} from '../src/wiki/wikitext.ts';
import { buildArticle, renderCodePage, parseCodePage, factKey, checkFactData, type CodeDoc } from '../src/wiki/pages.ts';
import { normalizeTitle, requireTitle, typeOfTitle, TitleError } from '../src/wiki/titles.ts';

test('markdown → wikitext: inline, headings, links', () => {
  const out = markdownToWikitext('# Title\n\nSome **bold**, *it*, `x<y>` and [[Library:CRIWARE ADX2]] and [site](https://example.com).');
  assert.match(out, /^== Title ==/);
  assert.match(out, /'''bold'''/);
  assert.match(out, /''it''/);
  assert.match(out, /<code><nowiki>x<y><\/nowiki><\/code>/);
  assert.match(out, /\[\[Library:CRIWARE ADX2\]\]/);
  assert.match(out, /\[https:\/\/example\.com site\]/);
});

test('markdown → wikitext normalizes body headings to a top level', () => {
  const out = markdownToWikitext('## Identification\n\ntext\n\n### Detail\n\nmore', { topLevel: 2 });
  assert.match(out, /^== Identification ==/);
  assert.match(out, /\n=== Detail ===/);
  assert.match(markdownToWikitext('# A', { topLevel: 3 }), /^=== A ===$/);
});

test('markdown → wikitext escapes wiki syntax in text', () => {
  const out = markdownToWikitext("Text with {{template}} and ''quotes'' and [http://x y] and ~~~~ and <script>.");
  assert.doesNotMatch(out, /\{\{template\}\}/);
  assert.doesNotMatch(out, /~~~~/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(escapeText('[[A]] [b]'), /^\[\[A\]\] &#91;b&#93;$/);
});

test('markdown → wikitext: lists stay one block, nested lists use stacked prefixes', () => {
  const out = markdownToWikitext('- one\n- two\n  1. a\n  2. b\n- three');
  assert.equal(out, '* one\n* two\n*# a\n*# b\n* three');
});

test('markdown → wikitext: tables and code', () => {
  const out = markdownToWikitext('| Offset | Name |\n|---|---|\n| 0x00 | a\\|b |\n\n```python\nprint("hi")\n```');
  assert.match(out, /\{\| class="wikitable"\n! Offset !! Name\n\|-\n\| 0x00 \|\| a&#124;b\n\|\}/);
  assert.match(out, /<syntaxhighlight lang="python">\nprint\("hi"\)\n<\/syntaxhighlight>/);
});

test('wikitext → markdown round trip of the supported subset', () => {
  const md = '## Header\n\nSome **bold** and *it* with `code`.\n\n- a\n- b\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```c\nint x;\n```';
  const back = wikitextToMarkdown(markdownToWikitext(md));
  assert.match(back, /^## Header/);
  assert.match(back, /\*\*bold\*\*/);
  assert.match(back, /`code`/);
  assert.match(back, /- a\n- b/);
  assert.match(back, /\| A \| B \|/);
  assert.match(back, /```c\nint x;\n```/);
});

test('sections ignore headings inside code blocks and replace cleanly', () => {
  const text = 'Lead\n\n== One ==\nbody1\n<syntaxhighlight lang="text">\n== not a heading ==\n</syntaxhighlight>\n\n== Two ==\nbody2\n';
  const sections = parseSections(text);
  assert.deepEqual(sections.map((s) => s.heading), ['', 'One', 'Two']);
  const updated = joinSections(replaceSectionBody(sections, 'two', 'new body'));
  assert.match(updated, /== Two ==\nnew body/);
  assert.match(updated, /== not a heading ==/);
  assert.equal(findSection(parseSections(updated), 'summary')?.level, 0);
});

test('infobox render/parse keeps link values with pipes', () => {
  const box = renderInfobox('Software', { developer: 'Sandlot', uses: '[[Library:CRIWARE ADX2]], [[Library:Havok]]', bad_key_with_UPPER: 'x' });
  const fields = parseInfobox(`${box}\nLead text.`);
  assert.equal(fields.type, 'Software');
  assert.equal(fields.developer, 'Sandlot');
  assert.equal(fields.uses, '[[Library:CRIWARE ADX2]], [[Library:Havok]]');
});

test('buildArticle keeps the infobox, summary and only the sections written', () => {
  const text = buildArticle({ type: 'format', title: 'Format:SGO (Sandlot)', summary: 'A data format.', infobox: { magic: '53 47 4F 00' }, bodyWikitext: '== Header ==\nFields.' });
  const headings = parseSections(text).map((s) => s.heading).filter(Boolean);
  assert.deepEqual(headings, ['Header']);
  assert.match(text, /\{\{Infobox[\s\S]*magic = 53 47 4F 00[\s\S]*\}\}\nA data format\./);
});

test('code pages round trip', () => {
  const doc: CodeDoc = {
    meta: {
      summary: 'Parses things.', language: 'python', kind: 'parser', subjects: ['Format:SGO (Sandlot)'], tested_on: 'samples',
      usage: 'python sgo.py file', license: 'MIT-0', status: 'claimed', created_by: 'A', created_at: 'now', verifications: [],
    },
    files: [{ name: 'sgo.py', lang: 'python', content: 'import struct\n\nprint("== x ==")' }, { name: 'README.md', lang: 'markdown', content: '# hi' }],
  };
  const parsed = parseCodePage(renderCodePage(doc));
  assert.deepEqual(parsed, doc);
});

test('fact helpers', () => {
  assert.deepEqual(checkFactData('function', { name: 'f', rva: '0x1A2B' }), []);
  assert.ok(checkFactData('function', { name: 'f' }).length > 0);
  assert.ok(checkFactData('magic', { bytes: 'XYZ', offset: 0, meaning: 'x' }).some((p) => p.includes('malformed')));
  assert.equal(factKey({ kind: 'function', data: { name: 'WeaponTable_Parse' } } as any), 'WeaponTable_Parse');
});

test('titles', () => {
  assert.equal(normalizeTitle('software:earth_defense_force 5'), 'Software:Earth defense force 5');
  assert.equal(typeOfTitle('Fact:X/y'), 'fact');
  assert.throws(() => requireTitle('Library:X', ['software']), TitleError);
  assert.throws(() => requireTitle('Software:A|B', ['software']), TitleError);
});

test('markdown → wikitext: MediaWiki tables written inside Markdown become real tables', () => {
  const out = markdownToWikitext('Header:\n{| class="wikitable"\n! Field !! Type\n|-\n| magic || u32\n|}\n\nAfter the table.', { topLevel: 2 });
  assert.match(out, /\{\| class="wikitable"\n! Field !! Type\n\|-\n\| magic \|\| u32\n\|\}/);
  assert.doesNotMatch(out, /&#123;/);
  assert.match(out, /^Header:/);
  assert.match(out, /After the table\./);
});
