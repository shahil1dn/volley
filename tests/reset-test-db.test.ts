// scripts/reset-test-db.ts wipes a database. Its guards are what stop it from ever touching
// anything but the one test project, so each is tested to be able to fail, and the tests prove that
// nothing connects before every guard has passed.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { PRODUCTION_REF } from '../scripts/production-guard.ts';
import { CONFIRM_FLAG, TEST_REF, resetTestDb, wipeableRefusal } from '../scripts/lib/reset-test-db.ts';

const urls = (ref: string, host = 'aws-0-eu-west-2.pooler.supabase.com') => ({
	SUPABASE_URL: `https://${ref}.supabase.co`,
	POSTGRES_URL: `postgres://postgres.${ref}:pw@${host}:6543/postgres`,
	POSTGRES_URL_NON_POOLING: `postgres://postgres.${ref}:pw@${host}:5432/postgres`,
});

function recordingDb() {
	const sql: string[] = [];
	const client = {
		query: async (text: string) => {
			sql.push(text.replace(/\s+/g, ' ').trim());
			return { rows: [], rowCount: 0 };
		},
		end: async () => undefined,
	} as unknown as pg.Client;
	return { client, sql };
}

test('the test project is accepted: exact ref in every address, with the flag', () => {
	assert.equal(wipeableRefusal(urls(TEST_REF), [CONFIRM_FLAG]), null);
	assert.equal(TEST_REF, 'gzwzfjukswcifikbsufm');
});

test('the comparison ignores letter case, so a differently-cased address is still the test project and still no other', () => {
	assert.equal(wipeableRefusal(urls(TEST_REF.toUpperCase()), [CONFIRM_FLAG]), null);
	assert.match(wipeableRefusal(urls(PRODUCTION_REF.toUpperCase()), [CONFIRM_FLAG]) ?? '', /production/);
});

test('every other project is refused, whichever setting carries it, and production is named', () => {
	const other = 'abcdefghijklmnopqrst';
	assert.match(wipeableRefusal(urls(other), [CONFIRM_FLAG]) ?? '', /isn't the test project/);
	assert.match(wipeableRefusal(urls(PRODUCTION_REF), [CONFIRM_FLAG]) ?? '', /production database/);
	for (const name of ['SUPABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING'] as const) {
		const mixed = { ...urls(TEST_REF), [name]: urls(other)[name] };
		assert.match(wipeableRefusal(mixed, [CONFIRM_FLAG]) ?? '', new RegExp(name), `a single stray ${name} must refuse`);
	}
	const sneaky = { ...urls(TEST_REF), SOME_OTHER_NAME: `https://${PRODUCTION_REF}.supabase.co` };
	assert.match(wipeableRefusal(sneaky, [CONFIRM_FLAG]) ?? '', /production database/, 'production under any name');
});

test('an address with no readable project ref, or no direct address at all, is refused', () => {
	assert.match(wipeableRefusal({ ...urls(TEST_REF), POSTGRES_URL_NON_POOLING: 'postgres://u:p@10.0.0.5:5432/postgres' }, [CONFIRM_FLAG]) ?? '', /POSTGRES_URL_NON_POOLING/);
	assert.match(wipeableRefusal({ SUPABASE_URL: urls(TEST_REF).SUPABASE_URL }, [CONFIRM_FLAG]) ?? '', /POSTGRES_URL_NON_POOLING/);
	assert.match(wipeableRefusal({}, [CONFIRM_FLAG]) ?? '', /POSTGRES_URL_NON_POOLING/);
});

test('without the confirmation flag it refuses, even for the test project', () => {
	assert.match(wipeableRefusal(urls(TEST_REF), []) ?? '', /--yes-wipe-volley-test-db/);
	assert.match(wipeableRefusal(urls(TEST_REF), ['--yes']) ?? '', /--yes-wipe-volley-test-db/);
});

test('nothing connects before every guard has passed; with all of them passed it connects once and ends', async () => {
	const refused: [string, Record<string, string>, string[]][] = [
		['wrong project', urls('abcdefghijklmnopqrst'), [CONFIRM_FLAG]],
		['production', urls(PRODUCTION_REF), [CONFIRM_FLAG]],
		['no flag', urls(TEST_REF), []],
	];
	for (const [label, env, args] of refused) {
		let connects = 0;
		await assert.rejects(resetTestDb(env, args, async () => (connects++, recordingDb().client)), /./, label);
		assert.equal(connects, 0, `${label}: connected before the guard passed`);
	}
	let connects = 0;
	const db = recordingDb();
	await resetTestDb(urls(TEST_REF), [CONFIRM_FLAG], async () => (connects++, db.client));
	assert.equal(connects, 1);
});

test('the wipe touches only Volley\'s objects in public, our cron job, and auth users: never a managed schema', async () => {
	const db = recordingDb();
	await resetTestDb(urls(TEST_REF), [CONFIRM_FLAG], async () => db.client);
	const all = db.sql.join('\n');
	assert.match(all, /delete from auth\.users/);
	assert.match(all, /cron\.unschedule\(jobid\) from cron\.job where jobname = 'volley-purge-expired'/, 'the job is unscheduled by name');
	assert.doesNotMatch(all, /drop schema/i, 'schemas are never dropped');
	assert.doesNotMatch(all, /drop extension/i, 'extensions belong to Supabase; the reset leaves them installed');
	assert.doesNotMatch(all, /truncate/i);
	for (const statement of db.sql) {
		for (const managed of ['storage', 'realtime', 'extensions', 'vault', 'graphql', 'pgsodium', 'supabase_functions', 'pg_catalog', 'information_schema']) {
			assert.doesNotMatch(statement, new RegExp(`(?:from|join|into|update|table|function|type|on)\\s+"?${managed}"?\\.`, 'i'), `touches ${managed}: ${statement.slice(0, 90)}`);
		}
	}
	assert.equal(db.sql[0], 'begin');
	assert.equal(db.sql.at(-1), 'commit');
});

test('a failure rolls the whole wipe back and still closes the connection', async () => {
	const sql: string[] = [];
	let ended = false;
	const client = { query: async (text: string) => { sql.push(text.trim()); if (/delete from auth\.users/.test(text)) throw new Error('boom'); return { rows: [], rowCount: 0 }; }, end: async () => { ended = true; } } as unknown as pg.Client;
	await assert.rejects(resetTestDb(urls(TEST_REF), [CONFIRM_FLAG], async () => client), /boom/);
	assert.ok(sql.includes('rollback') && !sql.includes('commit'));
	assert.equal(ended, true);
});

test('the command line refuses before connecting: a wrong ref at an unreachable address says "isn\'t the test project", not "connection refused"', () => {
	const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ['scripts/reset-test-db.ts', ...args], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', ...env } });
	// Real-looking addresses: a refusal happens before any lookup, so nothing here touches the network.
	const unreachable = (ref: string) => ({ POSTGRES_URL_NON_POOLING: `postgres://postgres.${ref}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`, SUPABASE_URL: `https://${ref}.supabase.co` });
	const wrong = run(unreachable('abcdefghijklmnopqrst'), CONFIRM_FLAG);
	assert.notEqual(wrong.status, 0);
	assert.match(wrong.stderr, /isn't the test project/);
	assert.doesNotMatch(wrong.stderr, /ECONNREFUSED|connect/i);
	const prod = run(unreachable(PRODUCTION_REF), CONFIRM_FLAG);
	assert.notEqual(prod.status, 0);
	assert.match(prod.stderr, /production database/);
	const noFlag = run(unreachable(TEST_REF));
	assert.notEqual(noFlag.status, 0);
	assert.match(noFlag.stderr, /--yes-wipe-volley-test-db/);
	assert.doesNotMatch(noFlag.stderr, /ECONNREFUSED/);
	assert.ok(!wrong.stdout.includes('pw'), 'no password printed');
});

// What pg-connection-string (the parser pg itself uses) makes of these is NOT what a regex sees: each
// one below reads as the test project to a pattern match and points somewhere else once parsed.
const CRAFTED: [string, string][] = [
	['a percent-encoded production ref in the host, with ?user= overriding the user', `postgresql://postgres.${TEST_REF}:pw@db.%71eheedlsskaurqshmueb.supabase.co:5432/postgres?user=postgres`],
	['?host= overriding the host', `postgresql://postgres.${TEST_REF}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?host=other.example.com`],
	['the test host as the start of a longer, hostile one', `postgresql://postgres:pw@db.${TEST_REF}.supabase.co.evil.com:5432/postgres`],
	['an IPv6 literal', `postgresql://postgres.${TEST_REF}:pw@[::1]:5432/postgres`],
	['an IPv4 literal', `postgresql://postgres.${TEST_REF}:pw@127.0.0.1:5432/postgres`],
	['the ref hidden in a query parameter', `postgresql://postgres:pw@10.0.0.9:5432/postgres?application_name=//${TEST_REF}.supabase.co`],
	['a query parameter that is not sslmode, on an otherwise right address', `postgresql://postgres.${TEST_REF}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?options=-c%20search_path%3Dx`],
	['the right user on a host that merely ENDS like a pooler', `postgresql://postgres.${TEST_REF}:pw@evil.aws-0-eu-west-2.pooler.supabase.com:5432/postgres`],
	['the right user on a pooler-lookalike host', `postgresql://postgres.${TEST_REF}:pw@aws-0-eu-west-2.pooler.supabase.com.evil.com:5432/postgres`],
	['the direct host with the pooler user', `postgresql://postgres.${TEST_REF}:pw@db.${TEST_REF}.supabase.co:5432/postgres`],
	['the pooler host with the direct user', `postgresql://postgres:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`],
	['a unix socket path', `postgresql://postgres.${TEST_REF}:pw@%2Fvar%2Frun%2Fpostgresql/postgres`],
];

test('addresses that only LOOK like the test project are refused, and nothing connects', async () => {
	for (const [label, address] of CRAFTED) {
		const env = { POSTGRES_URL_NON_POOLING: address, SUPABASE_URL: `https://${TEST_REF}.supabase.co`, POSTGRES_URL: urls(TEST_REF).POSTGRES_URL };
		assert.ok(wipeableRefusal(env, [CONFIRM_FLAG]), `the guard accepted: ${label}`);
		let connects = 0;
		await assert.rejects(resetTestDb(env, [CONFIRM_FLAG], async () => (connects++, recordingDb().client)), /./, label);
		assert.equal(connects, 0, `connected for: ${label}`);
	}
});

test('the two accepted shapes, with sslmode as the only query parameter, pass; and the connection gets the parsed fields, not a string', async () => {
	const accepted = [
		`postgresql://postgres:pw@db.${TEST_REF}.supabase.co:5432/postgres`,
		`postgresql://postgres:pw@db.${TEST_REF.toUpperCase()}.supabase.co:5432/postgres?sslmode=require`,
		`postgresql://postgres.${TEST_REF}:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require`,
		`postgresql://postgres.${TEST_REF}:pw@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,
	];
	for (const address of accepted) {
		const env = { POSTGRES_URL_NON_POOLING: address, SUPABASE_URL: `https://${TEST_REF}.supabase.co` };
		assert.equal(wipeableRefusal(env, [CONFIRM_FLAG]), null, address);
		let seen: Record<string, unknown> | null = null;
		await resetTestDb(env, [CONFIRM_FLAG], async (config) => ((seen = config as Record<string, unknown>), recordingDb().client));
		assert.ok(seen, address);
		const config = seen as Record<string, unknown>;
		assert.equal(config.connectionString, undefined, 'the string must not be parsed a second time by pg');
		assert.match(String(config.host).toLowerCase(), /^(db\.gzwzfjukswcifikbsufm\.supabase\.co|aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com)$/);
		assert.match(String(config.user).toLowerCase(), /^postgres(\.gzwzfjukswcifikbsufm)?$/);
	}
});

test('the script is not an npm script, so nobody runs it by accident', async () => {
	const { readFile } = await import('node:fs/promises');
	const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts as Record<string, string>;
	assert.ok(!Object.values(scripts).some((command) => command.includes('reset-test-db')));
});
