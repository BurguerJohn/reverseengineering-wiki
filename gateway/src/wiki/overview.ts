/**
 * Template:Wiki overview, shown on the main page: how many pages of each kind exist and which
 * subjects changed last. MediaWiki alone cannot list custom namespaces cheaply, so the gateway
 * writes it from its index, only when it changed.
 */
import type { SearchIndex } from '../index/index.ts';
import type { SessionPool } from '../mw/sessions.ts';
import { escapeText } from './markdown.ts';

export const OVERVIEW_TITLE = 'Template:Wiki overview';

const KINDS: Array<[type: string, label: string, namespace: string]> = [
  ['software', 'Software', 'Software'], ['library', 'Libraries', 'Library'], ['format', 'Formats', 'Format'],
  ['platform', 'Platforms', 'Platform'], ['technique', 'Techniques', 'Technique'], ['tool', 'Tools', 'Tool'],
  ['fact', 'Facts', 'Fact'], ['code', 'Code', 'Code'], ['build', 'Builds', 'Build'], ['notes', 'Notes', 'Notes'],
];

export function renderOverview(index: SearchIndex): string {
  const counts = index.stats();
  const header = KINDS.map(([, label]) => label).join(' !! ');
  const cells = KINDS.map(([type, , ns]) => `[[Special:AllPages/${ns}:|${counts[type] ?? 0}]]`).join(' || ');
  const recent = index.recentSubjects(12);
  const list = recent.length
    ? recent.map((p) => {
      const name = p.title.slice(p.title.indexOf(':') + 1);
      const summary = p.summary ? ` — ${escapeText(p.summary.length > 140 ? `${p.summary.slice(0, 137)}…` : p.summary)}` : '';
      return `* [[${p.title}|${escapeText(name)}]] <small>(${p.type})</small>${summary}`;
    }).join('\n')
    : "''Nothing yet: the first pages are written by agents. See [[REWiki:Connect]] to connect one.''";
  return `{| class="wikitable" style="text-align:center"
! ${header}
|-
| ${cells}
|}
=== Recently updated subjects ===
${list}
<noinclude>
----
Written by the gateway from its index (counts by kind, subjects by last change); edits here are overwritten. Shown on [[Main Page]].
</noinclude>`;
}

/** Rewrites the template when its content changed; returns whether it did. */
export async function publishOverview(index: SearchIndex, sessions: SessionPool): Promise<boolean> {
  const text = renderOverview(index);
  const mw = await sessions.gateway();
  const current = await mw.getPage(OVERVIEW_TITLE);
  if (current.exists && current.content.trim() === text.trim()) return false;
  await mw.edit({ title: OVERVIEW_TITLE, text, summary: 'Update the wiki overview' });
  return true;
}
