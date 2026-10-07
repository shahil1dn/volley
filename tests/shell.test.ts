// Anything a person types that ends up inside a suggested command or a database lookup.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL } from '../scripts/lib/make-host.ts';
import { shellQuote } from '../scripts/lib/shell.ts';

test('the email pattern refuses every character a shell treats specially, and still accepts ordinary addresses', () => {
	for (const bad of ['a$(id)@example.com', 'a;b@example.com', 'a|b@example.com', 'a`id`@example.com', 'a b@example.com', "a'b@example.com", 'a"b@example.com', 'a&b@example.com', 'a>b@example.com', 'a<b@example.com', 'a(b)@example.com', 'a\\b@example.com', 'a@b@example.com', 'a@example', 'a@example.com\n', '@example.com', 'a@.com', 'a@example.com;ls', '<EMAIL>']) {
		assert.equal(EMAIL.test(bad), false, JSON.stringify(bad));
	}
	for (const good of ['first.last+tag@sub.example.co.uk', 'a_b-c%d@example.com', 'volley-setup-0f1e2d3c@example.com', 'pat@example.org']) assert.equal(EMAIL.test(good), true, good);
});

test('shellQuote gives back exactly the value when a shell reads it, whatever the value holds', () => {
	for (const value of ['plain', 'a b', "it's", 'a"b', '$(touch /tmp/nope)', '`id`', 'a;b|c&d>e<f', '$HOME ${HOME}', '*?[x]', '\\', '', 'multi\nline', '-n', 'ünï']) {
		const run = spawnSync('sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
		assert.equal(run.stdout, value, JSON.stringify(value));
	}
	assert.equal(shellQuote('safe.name+1@example.com'), 'safe.name+1@example.com', 'a plain value is left as it is');
});
