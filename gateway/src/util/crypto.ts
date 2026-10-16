import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual,
} from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // Rejection sampling keeps the distribution uniform (248 = 4 * 62).
      if (byte < 248) out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Access tokens are "rewiki_" + 40 base62 chars; the prefix makes leaks detectable. */
export function newAccessToken(): string {
  return `rewiki_${randomBase62(40)}`;
}

export function newOneTimeCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Secrets {
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;

  constructor(secret: string) {
    const ikm = Buffer.from(secret, 'utf8');
    // The 'wikivibe' HKDF label predates the rename; changing it would invalidate every stored secret.
    this.encKey = Buffer.from(hkdfSync('sha256', ikm, 'wikivibe', 'encryption', 32));
    this.macKey = Buffer.from(hkdfSync('sha256', ikm, 'wikivibe', 'hmac', 32));
  }

  /** Keyed hash for lookups (e.g. email uniqueness) without storing the value in clear. */
  hmac(value: string): string {
    return createHmac('sha256', this.macKey).update(value).digest('hex');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(sealed: string): string {
    const [iv, tag, body] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
