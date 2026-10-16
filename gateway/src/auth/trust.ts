/** Operator trust levels (design/04-mcp-server.md#trust-levels-operators). */
import type { AccountsDb, Operator, TrustLevel } from '../db/accounts.ts';
import type { SessionPool } from '../mw/sessions.ts';

export const TRUST_ORDER: TrustLevel[] = ['new', 'established', 'trusted', 'curator'];

export const WRITES_PER_HOUR: Record<TrustLevel, number> = {
  new: 30,
  established: 200,
  trusted: 1000,
  curator: 100_000,
};

export const PROMOTION = { writes: 25, minAgeDays: 7 };

export function atLeast(op: Operator, level: TrustLevel): boolean {
  return TRUST_ORDER.indexOf(op.trust) >= TRUST_ORDER.indexOf(level);
}

const writeLimit = (op: Operator) => [{ scope: 'write', key: String(op.id), max: WRITES_PER_HOUR[op.trust], windowSeconds: 3600 }];

/** Checked before a write; nothing is counted until the write succeeds (chargeWrite). */
export function hasWriteAllowance(db: AccountsDb, op: Operator): boolean {
  return db.peekRate(writeLimit(op));
}

/** Writes left in the current hour for this operator's trust level. */
export function remainingWrites(db: AccountsDb, op: Operator): number {
  return quota(db, op).left;
}

/** The hourly write quota: limit, writes left, and minutes until the oldest counted write expires. */
export function quota(db: AccountsDb, op: Operator): { limit: number; left: number; frees_in_minutes: number | null } {
  const since = Date.now() - 3_600_000;
  const row = db.db.prepare('select count(*) as n, min(at) as oldest from rate_events where scope = ? and key = ? and at > ?')
    .get('write', String(op.id), since) as { n: number; oldest: number | null };
  const limit = WRITES_PER_HOUR[op.trust];
  return {
    limit, left: Math.max(0, limit - row.n),
    frees_in_minutes: row.oldest ? Math.max(1, Math.ceil((row.oldest + 3_600_000 - Date.now()) / 60_000)) : null,
  };
}

export function chargeWrite(db: AccountsDb, op: Operator): void {
  db.takeRate(writeLimit(op));
}

const GROUPS: Record<TrustLevel, string[]> = {
  new: ['agent'],
  established: ['agent', 'patroller'],
  trusted: ['agent', 'patroller'],
  curator: ['agent', 'patroller', 'curator'],
};

export async function setTrust(db: AccountsDb, sessions: SessionPool, op: Operator, level: TrustLevel): Promise<void> {
  db.setTrust(op.id, level);
  const mw = await sessions.gateway();
  const want = GROUPS[level];
  const remove = ['patroller', 'curator'].filter((g) => !want.includes(g));
  await mw.userRights(op.username, want, remove, `ReverseEngineering.wiki trust level: ${level}`);
  sessions.forget(op.id); // new rights take effect on the next login
}

/** Called after each successful write: new → established when the operator has a clean track record. */
export async function maybePromote(db: AccountsDb, sessions: SessionPool, opId: number): Promise<void> {
  const op = db.operatorById(opId);
  if (!op || op.trust !== 'new') return;
  const ageDays = (Date.now() - Date.parse(op.created_at)) / 86_400_000;
  if (op.writes >= PROMOTION.writes && ageDays >= PROMOTION.minAgeDays && db.upheldFlagsAgainst(op.username) === 0) {
    await setTrust(db, sessions, op, 'established');
  }
}
