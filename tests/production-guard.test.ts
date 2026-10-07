// The guard that keeps tests off the production database.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_REF, productionSetting } from '../scripts/production-guard.ts';

test('any setting that mentions the production ref is found, whatever its name', () => {
	assert.equal(productionSetting({ SUPABASE_URL: 'https://test.supabase.co' }), null);
	assert.equal(productionSetting({ A: 'x', POSTGRES_URL: `postgres://u:p@aws-0.pooler.supabase.com:6543/postgres?ref=${PRODUCTION_REF}` }), 'POSTGRES_URL');
	assert.equal(productionSetting({ SOMETHING_NEW: `https://${PRODUCTION_REF}.supabase.co` }), 'SOMETHING_NEW');
});

test('the ref is matched whatever its letter case (host names are case-insensitive)', () => {
	assert.equal(productionSetting({ POSTGRES_URL: `postgres://u:p@db.${PRODUCTION_REF.toUpperCase()}.supabase.co:5432/postgres` }), 'POSTGRES_URL');
	assert.equal(productionSetting({ X: `https://${PRODUCTION_REF.slice(0, 5).toUpperCase()}${PRODUCTION_REF.slice(5)}.supabase.co` }), 'X');
});

test('an encoded or overridden production ref is found: the guard reads the address the way pg does', () => {
	const encoded = `postgresql://postgres:pw@db.%71eheedlsskaurqshmueb.supabase.co:5432/postgres`;
	assert.equal(productionSetting({ POSTGRES_URL_NON_POOLING: encoded }), 'POSTGRES_URL_NON_POOLING');
	assert.equal(productionSetting({ X: `postgresql://postgres:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?host=db.%71eheedlsskaurqshmueb.supabase.co` }), 'X', '?host= with an encoded ref');
	assert.equal(productionSetting({ X: `postgresql://postgres.%71eheedlsskaurqshmueb:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres` }), 'X', 'an encoded ref in the user');
	assert.equal(productionSetting({ X: `https://%51EHEEDLSSKAURQSHMUEB.supabase.co` }), 'X', 'encoded and upper case');
	assert.equal(productionSetting({ X: `postgresql://postgres:pw@db.%2571eheedlsskaurqshmueb.supabase.co/postgres` }), 'X', 'encoded twice');
	assert.equal(productionSetting({ X: 'postgresql://postgres:p%zz@db.abcdefghijklmnopqrst.supabase.co/postgres', Y: 'not a url at all %' }), null, 'malformed values neither crash nor match');
});

// Each of these reads as something harmless to a pattern match and as production to whatever really
// connects: new URL() strips tabs and newlines and maps full-width and compatibility letters to ASCII, and
// percent-encoding can be layered. They are the probes from the security reviews.
const P = PRODUCTION_REF;
export const HOSTILE: [string, string][] = [
	['a tab inside the ref, then a space in a parameter', `postgresql://postgres:pw@db.${P.slice(0, 6)}\t${P.slice(6)}.supabase.co:5432/postgres?sslmode=require&application_name=volley x`],
	['a newline inside the ref, then a bad %', `postgresql://postgres:pw@db.${P.slice(0, 6)}\n${P.slice(6)}.supabase.co:5432/postgres?application_name=%zz`],
	['a tab and a ?sslcert= file', `postgresql://postgres:pw@db.${P.slice(0, 6)}\t${P.slice(6)}.supabase.co:5432/postgres?sslcert=/nonexistent`],
	['a full-width q, with ?host=localhost', `https://\uff51${P.slice(1)}.supabase.co/?host=localhost`],
	['a soft hyphen inside the ref, with ?host=localhost', `https://${P.slice(0, 6)}\u00ad${P.slice(6)}.supabase.co/?host=localhost`],
	['a long s (U+017F) in the ref, with ?host=localhost', `https://${P.replace('s', '\u017f')}.supabase.co/?host=localhost`],
	['four layers of percent-encoding', `postgresql://postgres:pw@db.%25252571${P.slice(1)}.supabase.co:5432/postgres`],
	['an encoded tab', `postgresql://postgres:pw@db.${P.slice(0, 6)}%09${P.slice(6)}.supabase.co:5432/postgres`],
	['the ref in the user, with a zero-width space', `postgresql://postgres.${P.slice(0, 6)}\u200b${P.slice(6)}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`],
];

test('production is found behind tabs, newlines, compatibility letters, soft hyphens and layered encoding', () => {
	for (const [label, value] of HOSTILE) assert.equal(productionSetting({ POSTGRES_URL_NON_POOLING: value }), 'POSTGRES_URL_NON_POOLING', label);
	// The genuine test-project address, and unrelated values, are still left alone.
	assert.equal(productionSetting({ POSTGRES_URL_NON_POOLING: 'postgresql://postgres.gzwzfjukswcifikbsufm:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require', SUPABASE_URL: 'https://gzwzfjukswcifikbsufm.supabase.co', HOST_SESSION_SECRET: 'k'.repeat(64) }), null);
});

test('the production check never reads a file named in an address, and a bad one does not stop it', () => {
	const reads = mock.method(fs, 'readFileSync', () => {
		throw new Error('a file was read');
	});
	try {
		assert.equal(productionSetting({ X: 'postgresql://u:p@h.example.com:5432/db?sslrootcert=/dev/stdin&sslcert=/nonexistent&sslkey=/nonexistent&sslmode=verify-full' }), null);
		assert.equal(productionSetting({ X: `postgresql://u:p@db.%71eheedlsskaurqshmueb.supabase.co:5432/db?sslrootcert=/nonexistent&host=localhost` }), 'X', 'still found, with a file parameter present');
		assert.equal(reads.mock.callCount(), 0, 'a file was read while checking');
	} finally {
		reads.mock.restore();
	}
});

// The real preload, in a real process: with a production setting, nothing
// after it runs.
function runWithPreload(env: Record<string, string>) {
	return spawnSync(process.execPath, ['--import', './tests/refuse-production.ts', '-e', 'console.log("TEST CODE RAN")'], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', ...env },
	});
}

test('npm test refuses to start when a setting points at production', () => {
	const refused = runWithPreload({ POSTGRES_URL_NON_POOLING: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres` });
	assert.notEqual(refused.status, 0);
	assert.doesNotMatch(refused.stdout, /TEST CODE RAN/);
	assert.match(refused.stderr, /Refusing to run the tests: POSTGRES_URL_NON_POOLING points at the production database/);

	const allowed = runWithPreload({ POSTGRES_URL_NON_POOLING: 'postgres://postgres.sometestref:pw@127.0.0.1:1/postgres' });
	assert.equal(allowed.status, 0);
	assert.match(allowed.stdout, /TEST CODE RAN/);
});

test('the browser tests refuse too, before the dev server starts', () => {
	// Loading the config is the first thing Playwright does.
	const refused = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list'], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` },
	});
	assert.notEqual(refused.status, 0);
	assert.match(refused.stdout + refused.stderr, /Refusing to run the browser tests: SUPABASE_URL points at the production database/);
});

test('migrate refuses production unless --production is given', () => {
	const refused = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', POSTGRES_URL_NON_POOLING: `postgres://postgres.${PRODUCTION_REF}:pw@127.0.0.1:1/postgres` },
	});
	assert.notEqual(refused.status, 0);
	assert.match(refused.stderr, /points at the production database/);
	assert.match(refused.stderr, /--production/);
});

test('npm test preloads the guard', async () => {
	const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
	assert.match(scripts.test, /--import \.\/tests\/refuse-production\.ts/);
});
