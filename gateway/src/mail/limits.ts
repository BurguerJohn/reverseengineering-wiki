/** Send limits (anti email-bombing), design/08-accounts-and-auth.md#codes. */
import type { AccountsDb } from '../db/accounts.ts';

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/**
 * Caps how many different accounts one connection may try (anti enumeration): 5 per hour,
 * 20 per day. Retrying the same email or username is not a new account. `idHash` identifies
 * the target account (its email hash when it exists, else what was typed).
 */
export function takeIdentifierAllowance(db: AccountsDb, ip: string, idHash: string): boolean {
  const seen = { scope: 'id-seen', key: `${ip}|${idHash}`, max: 1, windowSeconds: DAY };
  if (!db.peekRate([seen])) return true;
  return db.takeRate([
    { scope: 'id-distinct-hour', key: ip, max: 5, windowSeconds: HOUR },
    { scope: 'id-distinct-day', key: ip, max: 20, windowSeconds: DAY },
    seen,
  ]);
}

export function takeSendAllowance(db: AccountsDb, opts: { emailHash?: string; ip: string; username?: string }): boolean {
  const limits = [{ scope: 'mail-ip', key: opts.ip, max: 10, windowSeconds: HOUR }];
  if (opts.emailHash) {
    limits.push({ scope: 'mail-email-15m', key: opts.emailHash, max: 3, windowSeconds: 15 * MINUTE });
    limits.push({ scope: 'mail-email-day', key: opts.emailHash, max: 10, windowSeconds: DAY });
  }
  if (opts.username) limits.push({ scope: 'mail-username', key: opts.username, max: 5, windowSeconds: HOUR });
  return db.takeRate(limits);
}
