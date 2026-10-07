// The guard that keeps tests off the production database.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
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
