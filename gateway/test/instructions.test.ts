import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INSTRUCTIONS, READ_ONLY_NOTE, SERVER_INSTRUCTIONS, oauthNote } from '../src/mcp/instructions.ts';

test('server instructions fit what clients keep (Claude Code cuts at 4096 characters)', () => {
  const longest = 'X'.repeat(32);
  for (const note of [READ_ONLY_NOTE, oauthNote(longest, 'review'), oauthNote(longest, 'write'), oauthNote(longest, 'read'), '']) {
    const full = note + SERVER_INSTRUCTIONS;
    assert.ok(full.length <= MAX_INSTRUCTIONS, `${full.length} characters`);
  }
  assert.ok(MAX_INSTRUCTIONS < 4096);
});

test('the account note comes first and keeps the review rules', () => {
  const note = oauthNote('QuietTracer42', 'review');
  assert.match(note, /^You are logged in as QuietTracer42/);
  for (const must of ['review_url', 'review_id', 'batch', 'never merge', 'never open the link']) assert.ok(note.includes(must), must);
  for (const must of ['PUBLIC wiki', 'English', 'Theories are welcome', 'NEVER PUBLISH', '[[Page#Section]]', 'Format:NE']) assert.ok(SERVER_INSTRUCTIONS.includes(must), must);
});
