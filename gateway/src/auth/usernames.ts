/** Username rules (design/08-accounts-and-auth.md#usernames). Usernames are public on every edit. */

const RESERVED = new Set([
  'admin', 'administrator', 'root', 'system', 'rewiki', 'gateway', 'curator', 'moderator', 'mod', 'sysop',
  'bureaucrat', 'oversight', 'suppress', 'support', 'staff', 'official', 'security', 'mediawiki', 'anonymous',
  'agent', 'operator', 'bot', 'null', 'undefined', 'claude', 'anthropic', 'openai', 'webmaster', 'postmaster',
]);

export interface UsernameCheck {
  ok: boolean;
  username: string;
  key: string;
  skeleton: string;
  reason?: string;
}

/** MediaWiki capitalizes the first letter of user names; we store them the same way. */
export function canonicalUsername(raw: string): string {
  const s = raw.trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function usernameKey(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, ' ');
}

/** Collapses look-alike characters so "Adm1n" and "admin" collide. */
export function skeleton(name: string): string {
  return name
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[0o]/g, 'o')
    .replace(/[1il|!]/g, 'l')
    .replace(/3/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/[-_. ]/g, '');
}

export function checkUsername(raw: string): UsernameCheck {
  const username = canonicalUsername(raw);
  const result = (reason?: string): UsernameCheck => ({
    ok: !reason, username, key: usernameKey(username), skeleton: skeleton(username), reason,
  });
  if (username.length < 3 || username.length > 32) return result('must be 3–32 characters');
  if (/@|\.(com|net|org|br|io)$/i.test(username)) return result('must not look like an email address');
  if (!/^[A-Za-z0-9_-]+$/.test(username)) return result('only letters, digits, "-" and "_" are allowed');
  if (/^\d+$/.test(username)) return result('must contain at least one letter');
  if (/^[-_]|[-_]$/.test(username)) return result('must not start or end with "-" or "_"');
  const lower = username.toLowerCase();
  const sk = skeleton(username);
  for (const word of RESERVED) {
    if (lower === word || sk === skeleton(word) || lower.startsWith(`${word}-`) || lower.startsWith(`${word}_`)) {
      return result('is reserved');
    }
  }
  return result();
}

export function suggestions(base: string, taken: (name: string) => boolean): string[] {
  const clean = canonicalUsername(base.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 26) || 'Agent');
  const out: string[] = [];
  for (const suffix of ['-re', '-dev', '_rev', `${new Date().getFullYear() % 100}`, String(Math.floor(Math.random() * 900 + 100))]) {
    const candidate = `${clean}${suffix}`;
    if (checkUsername(candidate).ok && !taken(candidate)) out.push(candidate);
    if (out.length === 3) break;
  }
  return out;
}

const ADJECTIVES = ['Quiet', 'Swift', 'Patient', 'Clever', 'Steady', 'Bright', 'Silent', 'Curious', 'Careful', 'Lucky', 'Brave', 'Calm', 'Keen', 'Sharp', 'Nimble', 'Bold', 'Gentle', 'Sly', 'Tidy', 'Wise'];
const NOUNS = ['Tracer', 'Parser', 'Decoder', 'Patcher', 'Linker', 'Loader', 'Stepper', 'Mapper', 'Lifter', 'Packer', 'Hexer', 'Prober', 'Tinkerer', 'Splicer', 'Seeker', 'Reader'];

/** A random public name for a new account ("QuietTracer42"); the operator can change it later. */
export function randomUsername(taken: (name: string) => boolean): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
    const digits = attempt < 30 ? 2 : 4;
    const number = Math.floor(10 ** (digits - 1) + Math.random() * 9 * 10 ** (digits - 1));
    const name = `${pick(ADJECTIVES)}${pick(NOUNS)}${number}`;
    if (checkUsername(name).ok && !taken(name)) return name;
  }
  return `Reverser${Date.now().toString(36)}`;
}
