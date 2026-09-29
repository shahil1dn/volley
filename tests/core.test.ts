import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centreOut, countWords, normaliseWord } from '../src/lib/words.ts';
import { CODE_PATTERN, hashHostToken, hostTokenMatches, makeHostToken, makeJoinCode } from '../src/lib/server/host-token.ts';

test('normaliseWord merges case and spacing, rejects empty and overlong', () => {
  assert.equal(normaliseWord('  Machine   Learning '), 'machine learning');
  assert.equal(normaliseWord('AI'), 'ai');
  assert.equal(normaliseWord('   '), null);
  assert.equal(normaliseWord('a'.repeat(25)), 'a'.repeat(25));
  assert.equal(normaliseWord('a'.repeat(26)), null);
  // Emoji count as one character each, as in the database's check.
  assert.equal(normaliseWord('😀'.repeat(25)), '😀'.repeat(25));
  assert.equal(normaliseWord('😀'.repeat(26)), null);
});

test('countWords counts repeats and orders biggest first, ties alphabetical', () => {
  // deliberately out of order, so an unsorted result cannot pass
  assert.deepEqual(countWords(['zebra', 'ai', 'bots', 'ai', 'zebra', 'ai']), [
    { text: 'ai', count: 3 },
    { text: 'zebra', count: 2 },
    { text: 'bots', count: 1 },
  ]);
  assert.deepEqual(countWords(['b', 'a']), [{ text: 'a', count: 1 }, { text: 'b', count: 1 }]);
});

test('centreOut puts the biggest word in the middle', () => {
  assert.deepEqual(centreOut([1, 2, 3, 4, 5]), [4, 2, 1, 3, 5]);
});

test('join codes are 5 unambiguous characters', () => {
  for (let i = 0; i < 500; i++) {
    const code = makeJoinCode();
    assert.match(code, CODE_PATTERN);
    assert.doesNotMatch(code, /[01IO]/);
  }
});

test('host key: only the right token matches the stored hash', () => {
  const token = makeHostToken();
  const stored = hashHostToken(token);
  assert.equal(hostTokenMatches(token, stored), true);
  assert.equal(hostTokenMatches(makeHostToken(), stored), false);
  assert.equal(hostTokenMatches(token, 'abc'), false);
  assert.notEqual(stored, token);
});
