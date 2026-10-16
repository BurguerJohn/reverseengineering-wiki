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
}

const BINARY_ASSET = /\.(exe|dll|msi|scr|zip|7z|rar|bin|so|dylib|apk|jar)$/i;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(url, { headers: { 'User-Agent': 'REWikiGateway/0.1', Accept: 'application/json', ...headers } });
  if (response.status === 404) throw new ToolError('NOT_FOUND', 'Repository not found or not public.');
  if (response.status === 403 || response.status === 429) throw new ToolError('RATE_LIMITED', 'Repository host rate limit reached. Try again later.');
  if (!response.ok) throw new ToolError('UPSTREAM_ERROR', `Repository host answered HTTP ${response.status}.`);
  return response.json();
}

export function parseRepoUrl(raw: string): { host: 'github' | 'gitlab' | 'codeberg'; owner: string; repo: string; url: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ToolError('BAD_REQUEST', 'url must be a full https URL to a repository.');
  }
  if (url.protocol !== 'https:') throw new ToolError('BAD_REQUEST', 'Only https repository URLs are accepted.');
  const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  const kind = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : host === 'codeberg.org' ? 'codeberg' : null;
  if (!kind || parts.length < 2) throw new ToolError('BAD_REQUEST', 'Supported hosts: github.com, gitlab.com, codeberg.org (https://host/owner/repo).');
  const [owner, repo] = kind === 'gitlab' ? [parts.slice(0, -1).join('/'), parts[parts.length - 1]] : [parts[0], parts[1]];
  return { host: kind, owner, repo, url: `https://${host}/${owner}/${repo}` };
}

export async function resolveRepo(raw: string, commit?: string): Promise<RepoInfo> {
  const r = parseRepoUrl(raw);
  if (commit && !/^[0-9a-f]{7,40}$/i.test(commit)) throw new ToolError('BAD_REQUEST', 'commit must be a hex SHA.');

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
    return {
      url: r.url, commit: c.sha, license: repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : 'none',
      archived: !!repo.archived, lastCommit: repo.pushed_at ?? null, binaryReleaseAssets: binaries,
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
