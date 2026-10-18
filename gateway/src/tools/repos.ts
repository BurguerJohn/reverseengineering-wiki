/**
 * Resolves public repositories for link_repo: checks they are public, pins a
 * commit SHA, detects the license and flags binary release assets.
 */
import { ToolError } from './context.ts';

export interface RepoInfo {
  url: string;
  commit: string;
  license: string;
  archived: boolean;
  lastCommit: string | null;
  binaryReleaseAssets: boolean;
  /** An SPDX expression found in a license file GitHub did not recognize: a hint, never applied on its own. */
  licenseHint?: string;
  /** GitHub's API was rate-limited: commit and license come from git and the repository's files, archive state is unknown. */
  limited?: boolean;
}

/** An SPDX id or expression: "MIT", "Apache-2.0 WITH LLVM-exception", "(MIT OR Apache-2.0)". */
export const SPDX_EXPRESSION = /^\(?[A-Za-z0-9.+-]{2,40}(?:\s+(?:WITH|OR|AND)\s+\(?[A-Za-z0-9.+-]{2,40}\)?)*\)?$/;

/**
 * "SPDX-License-Identifier: MIT", or ids joined by OR/AND/WITH ("dual [Apache-2.0](...) OR [GPL-2.0-or-later](...)
 * license", Mbed TLS) in a license file's text.
 */
export function licenseHint(text: string): string | undefined {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const id = String.raw`(?:[A-Za-z][A-Za-z0-9.+]*-[A-Za-z0-9.+-]*\d[A-Za-z0-9.+-]*|[A-Za-z0-9.+-]+-exception|MIT|ISC|Zlib|Unlicense|0BSD)`;
  const tagged = /SPDX-License-Identifier:\s*([^\n*]+?)\s*(?:\*\/|-->|$)/im.exec(plain)?.[1];
  const joined = new RegExp(String.raw`\(?${id}\)?(?:\s+(?:OR|AND|WITH)\s+\(?${id}\)?)+`).exec(plain)?.[0];
  const hint = (tagged ?? joined)?.replace(/\s+/g, ' ').trim();
  if (hint && hint.length <= 120 && SPDX_EXPRESSION.test(hint)) return hint;
  // Whole license texts GitHub sometimes misses (reformatted or with a header added).
  const flat = plain.replace(/\s+/g, ' ');
  const KNOWN_TEXTS: Array<[RegExp, string]> = [
    [/This is free and unencumbered software released into the public domain/i, 'Unlicense'],
    [/Boost Software License - Version 1\.0/i, 'BSL-1.0'],
    [/Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely/i, 'Zlib'],
    [/Permission is hereby granted, free of charge, to any person obtaining a copy of this software/i, 'MIT'],
    [/Apache License,? Version 2\.0/i, 'Apache-2.0'],
    [/Redistribution and use in source and binary forms[\s\S]*Neither the name/i, 'BSD-3-Clause'],
    [/Redistribution and use in source and binary forms/i, 'BSD-2-Clause'],
    [/wxWindows Library Licence/i, 'wxWindows'],
    [/Mozilla Public License,? (?:v. |version )2.0/i, 'MPL-2.0'],
    [/ISC License/i, 'ISC'],
  ];
  return KNOWN_TEXTS.find(([re]) => re.test(flat))?.[1];
}

const BINARY_ASSET = /\.(exe|dll|msi|scr|zip|7z|rar|bin|so|dylib|apk|jar)$/i;

/** The top-level files and folders of a GitHub repository at a commit (folders end in "/"), to plan what to read. */
export async function repoRootFiles(url: string, commit: string): Promise<string[] | undefined> {
  const r = parseRepoUrl(url);
  if (r.host !== 'github') return undefined;
  const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  try {
    const list = await getJson(`https://api.github.com/repos/${r.owner}/${r.repo}/contents/?ref=${commit}`, headers) as Array<{ name: string; type: string }>;
    return list.map((x) => (x.type === 'dir' ? `${x.name}/` : x.name)).slice(0, 80);
  } catch {
    return undefined;
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, { headers: { 'User-Agent': 'REWikiGateway/0.1', Accept: 'application/json', ...headers } });
  if (response.status === 404) throw new ToolError('NOT_FOUND', 'Repository not found or not public.');
  if (response.status === 403 || response.status === 429) {
    const reset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
    const minutes = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60_000)) : 0;
    throw new ToolError('RATE_LIMITED', `Repository host rate limit reached. ${minutes ? `It resets in about ${minutes} minutes.` : 'Try again later.'}`, minutes ? { retry_after_minutes: minutes } : undefined);
  }
  if (!response.ok) throw new ToolError('UPSTREAM_ERROR', `Repository host answered HTTP ${response.status}.`);
  return response.json();
}

export function parseRepoUrl(raw: string): { host: 'github' | 'gitlab' | 'codeberg' | 'gitiles'; owner: string; repo: string; url: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError('BAD_REQUEST', 'url must be a full https URL to a repository.');
  }
  if (url.protocol !== 'https:') throw new ToolError('BAD_REQUEST', 'Only https repository URLs are accepted.');
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  // Gitiles (android.googlesource.com, chromium.googlesource.com): AOSP and Chromium live there, not on GitHub.
  const kind = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'codeberg.org' ? 'codeberg' : /^[a-z0-9-]+\.googlesource\.com$/.test(host) ? 'gitiles' : null;
  const cut = kind === 'gitiles' ? parts.indexOf('+') : -1;
  const path = cut >= 0 ? parts.slice(0, cut) : parts;
  if (!kind || path.length < (kind === 'gitiles' ? 1 : 2)) throw new ToolError('BAD_REQUEST', 'Supported hosts: github.com, gitlab.com, codeberg.org (https://host/owner/repo) and *.googlesource.com (https://android.googlesource.com/platform/...).');
  const [owner, repo] = kind === 'gitlab' || kind === 'gitiles' ? [path.slice(0, -1).join('/'), path[path.length - 1]] : [path[0], path[1]];
  if (kind === 'gitiles') return { host: kind, owner, repo, url: `https://${host}/${path.join('/')}` };
  return { host: kind, owner, repo, url: `https://${host}/${owner}/${repo}` };
}

// Several agents link the same repositories: one answer per repository and commit for six hours.
const REPO_CACHE = new Map<string, { at: number; info: RepoInfo }>();
const REPO_TTL_MS = 6 * 3600_000;

export async function resolveRepo(raw: string, commit?: string): Promise<RepoInfo> {
  const r = parseRepoUrl(raw);
  // A branch or tag ("llvm-4.0", "v1.2.3") is resolved to the commit it points at now; the answer pins that SHA.
  if (commit && !/^[0-9a-f]{7,40}$/i.test(commit) && !/^[\w][\w.\/-]{0,99}$/.test(commit)) throw new ToolError('BAD_REQUEST', 'commit must be a SHA, a branch or a tag.');
  const key = `${r.url}|${commit?.toLowerCase() ?? ''}`;
  const hit = REPO_CACHE.get(key);
  if (hit && Date.now() - hit.at < REPO_TTL_MS) return { ...hit.info };
  let info: RepoInfo;
  try {
    info = await resolveFresh(r, commit);
  } catch (error) {
    // GitHub's API allows 60 calls an hour without a token: git and the raw files are not counted.
    if (!(error instanceof ToolError) || error.code !== 'RATE_LIMITED' || r.host !== 'github') throw error;
    info = await resolveWithoutApi(r, commit);
  }
  if (REPO_CACHE.size > 2000) REPO_CACHE.delete(REPO_CACHE.keys().next().value!);
  REPO_CACHE.set(key, { at: Date.now(), info });
  if (!commit) REPO_CACHE.set(`${r.url}|${info.commit}`, { at: Date.now(), info });
  return { ...info };
}

/** The commit from git's own HTTP protocol, the license from the repository's files: no API call. */
async function resolveWithoutApi(r: ReturnType<typeof parseRepoUrl>, commit?: string): Promise<RepoInfo> {
  let sha = commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : undefined;
  if (!sha) {
    const refs = await fetch(`https://github.com/${r.owner}/${r.repo}.git/info/refs?service=git-upload-pack`, { headers: { 'User-Agent': 'git/2.40 REWikiGateway' } });
    if (refs.status === 404 || refs.status === 401) throw new ToolError('NOT_FOUND', 'Repository not found or not public.');
    if (!refs.ok) throw new ToolError('RATE_LIMITED', 'Repository host rate limit reached. Try again later.');
    const listing = await refs.text();
    const name = commit?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A tag's peeled line (^{}) names the commit; a branch line names it directly.
    const head = name
      ? new RegExp(`([0-9a-f]{40}) refs/tags/${name}\\^\\{\\}`).exec(listing) ?? new RegExp(`([0-9a-f]{40}) refs/(?:heads|tags)/${name}(?:\\s|$)`, 'm').exec(listing)
      : /([0-9a-f]{40}) HEAD/.exec(listing);
    if (!head) throw new ToolError(name ? 'NOT_FOUND' : 'RATE_LIMITED', name ? `No branch or tag "${commit}" in ${r.url}.` : 'Repository host rate limit reached. Try again later.');
    sha = head[1];
  }
  let license = 'unknown';
  let hint: string | undefined;
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'LICENCE', 'LICENSE.TXT', 'COPYING.txt', 'UNLICENSE']) {
    const res = await fetch(`https://raw.githubusercontent.com/${r.owner}/${r.repo}/${sha}/${name}`, { headers: { 'User-Agent': 'REWikiGateway/0.1' } });
    if (!res.ok) continue;
    hint = licenseHint((await res.text()).slice(0, 20000));
    license = hint ? `${hint} (read from ${name}; GitHub's API was busy)` : `unrecognized (${name})`;
    break;
  }
  return { url: r.url, commit: sha, license, archived: false, lastCommit: null, binaryReleaseAssets: false, licenseHint: hint, limited: true };
}

/** Gitiles answers JSON behind a ")]}'" guard line, and files as base64 with ?format=TEXT. */
async function gitilesJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': 'REWikiGateway/0.1' } });
  if (res.status === 404) throw new ToolError('NOT_FOUND', 'Repository or commit not found.');
  if (res.status === 429 || res.status === 403) throw new ToolError('RATE_LIMITED', 'Repository host rate limit reached. Try again later.');
  if (!res.ok) throw new ToolError('UPSTREAM_ERROR', `Repository host answered HTTP ${res.status}.`);
  return JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ''));
}

export async function gitilesFile(repoUrl: string, commit: string, path: string): Promise<string | null> {
  const res = await fetch(`${repoUrl}/+/${commit}/${path.split('/').map(encodeURIComponent).join('/')}?format=TEXT`, { headers: { 'User-Agent': 'REWikiGateway/0.1' } });
  if (!res.ok) return null;
  return Buffer.from(await res.text(), 'base64').toString('utf8');
}

async function resolveFresh(r: ReturnType<typeof parseRepoUrl>, commit?: string): Promise<RepoInfo> {
  if (r.host === 'gitiles') {
    const c = await gitilesJson(`${r.url}/+/${commit ?? 'HEAD'}?format=JSON`);
    const sha = String(c.commit);
    let license = 'unknown';
    let hint: string | undefined;
    for (const name of ['LICENSE', 'COPYING', 'NOTICE', 'LICENSE.txt']) {
      const text = await gitilesFile(r.url, sha, name);
      if (text === null) continue;
      hint = licenseHint(text.slice(0, 20000));
      license = hint ? `${hint} (read from ${name})` : `unrecognized (${name})`;
      break;
    }
    return { url: r.url, commit: sha, license, archived: false, lastCommit: c.committer?.time ? new Date(c.committer.time).toISOString() : null, binaryReleaseAssets: false, licenseHint: hint };
  }
  if (r.host === 'github') {
    const headers: Record<string, string> = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const api = `https://api.github.com/repos/${r.owner}/${r.repo}`;
    const repo = await getJson(api, headers);
    if (repo.private) throw new ToolError('POLICY_BLOCKED', 'Only public repositories can be linked.');
    const c = await getJson(`${api}/commits/${commit ?? repo.default_branch}`, headers);
    let binaries = false;
    try {
      const release = await getJson(`${api}/releases/latest`, headers);
      binaries = (release.assets ?? []).some((a: any) => BINARY_ASSET.test(a.name));
    } catch {
      // No releases.
    }
    let hint: string | undefined;
    let license = repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : 'none';
    if (license === 'none') {
      // GitHub's detector misses many license files (LICENSE.TXT with an exception, COPYING with headers).
      try {
        const root = await getJson(`${api}/contents/?ref=${c.sha}`, headers) as Array<{ name: string; type: string }>;
        const file = root.find((x) => x.type === 'file' && /^(?:licen[cs]e|copying|unlicense)(?:[._-].*)?$/i.test(x.name));
        if (file) {
          license = `unrecognized (${file.name})`;
          const body = await getJson(`${api}/contents/${encodeURIComponent(file.name)}?ref=${c.sha}`, headers) as { content?: string; encoding?: string };
          if (body.encoding === 'base64' && body.content) hint = licenseHint(Buffer.from(body.content, 'base64').toString('utf8').slice(0, 20000));
          // The file names its license clearly (an SPDX tag or a known text): recorded, and said where it comes from.
          if (hint) license = `${hint} (read from ${file.name}; GitHub's detector did not classify it)`;
        }
      } catch {
        // Listing failed: keep "none".
      }
    }
    return {
      url: r.url, commit: c.sha, license,
      archived: !!repo.archived, lastCommit: repo.pushed_at ?? null, binaryReleaseAssets: binaries, licenseHint: hint,
    };
  }

  if (r.host === 'gitlab') {
    const id = encodeURIComponent(`${r.owner}/${r.repo}`);
    const api = `https://gitlab.com/api/v4/projects/${id}`;
    const repo = await getJson(`${api}?license=true`);
    if (repo.visibility && repo.visibility !== 'public') throw new ToolError('POLICY_BLOCKED', 'Only public repositories can be linked.');
    const c = await getJson(`${api}/repository/commits/${encodeURIComponent(commit ?? repo.default_branch)}`);
    return {
      url: r.url, commit: c.id, license: repo.license?.key ? String(repo.license.key).toUpperCase() : 'none',
      archived: !!repo.archived, lastCommit: repo.last_activity_at ?? null, binaryReleaseAssets: false,
    };
  }

  const api = `https://codeberg.org/api/v1/repos/${r.owner}/${r.repo}`;
  const repo = await getJson(api);
  if (repo.private) throw new ToolError('POLICY_BLOCKED', 'Only public repositories can be linked.');
  const c = await getJson(`${api}/git/commits/${commit ?? repo.default_branch}`).catch(async () => {
    const branch = await getJson(`${api}/branches/${encodeURIComponent(commit ?? repo.default_branch)}`);
    return { sha: branch.commit.id };
  });
  let binaries = false;
  try {
    const release = await getJson(`${api}/releases/latest`);
    binaries = (release.assets ?? []).some((a: any) => BINARY_ASSET.test(a.name));
  } catch {
    // No releases.
  }
  return {
    url: r.url, commit: c.sha, license: repo.licenses?.[0] ?? 'unknown', archived: !!repo.archived,
    lastCommit: repo.updated_at ?? null, binaryReleaseAssets: binaries,
  };
}
