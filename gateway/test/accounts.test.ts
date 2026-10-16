import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountsDb } from '../src/db/accounts.ts';
import { sameOperator, type Services } from '../src/tools/context.ts';
import { checkUsername, randomUsername, usernameKey } from '../src/auth/usernames.ts';

function operator(db: AccountsDb, username: string, email: string): number {
  return db.insertOperator({
    username, username_key: usernameKey(username), skeleton: checkUsername(username).skeleton,
    email_enc: 'x', email_hash: email, mw_password_enc: 'x', trust: 'new', mode: 'review',
    terms_version: 't', terms_accepted_at: 't', created_at: new Date().toISOString(),
  });
}

test('a renamed operator stays the same operator for facts and code it created under the old name', () => {
  const db = new AccountsDb(':memory:');
  const s = { db } as unknown as Services;
  const a = operator(db, 'QuietTracer42', 'a');
  const b = operator(db, 'Someone-else', 'b');
  db.renameOperator(a, { username: 'Grisk-new', username_key: usernameKey('Grisk-new'), skeleton: checkUsername('Grisk-new').skeleton });
  const renamed = db.operatorById(a)!;
  assert.equal(renamed.username, 'Grisk-new');
  // created_by on old pages still says QuietTracer42: verifying them is not independent.
  assert.equal(sameOperator(s, 'QuietTracer42', renamed), true);
  assert.equal(sameOperator(s, 'Grisk-new', renamed), true);
  assert.equal(sameOperator(s, 'QuietTracer42', db.operatorById(b)!), false);
  assert.equal(sameOperator(s, undefined, renamed), false);
});

test('old names stay reserved for other accounts, not for their owner', () => {
  const db = new AccountsDb(':memory:');
  const a = operator(db, 'QuietTracer42', 'a');
  const b = operator(db, 'Other', 'b');
  db.renameOperator(a, { username: 'NewName', username_key: usernameKey('NewName'), skeleton: checkUsername('NewName').skeleton });
  const old = checkUsername('QuietTracer42');
  assert.equal(db.usernameRetired(old.key, old.skeleton), true);
  assert.equal(db.usernameRetired(old.key, old.skeleton, b), true);
  assert.equal(db.usernameRetired(old.key, old.skeleton, a), false, 'the owner may take its old name back');
  const lookAlike = checkUsername('QuietTracer4Z');
  assert.equal(db.usernameRetired(lookAlike.key, checkUsername('Qu1etTracer42').skeleton), true, 'look-alikes of old names are blocked too');
  assert.equal(lookAlike.ok, true);
});

test('random usernames are valid and avoid taken names', () => {
  const taken = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const name = randomUsername((n) => taken.has(n));
    assert.equal(checkUsername(name).ok, true, name);
    assert.ok(!taken.has(name));
    taken.add(name);
  }
});
