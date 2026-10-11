// The load script drives 200 phones at a URL. These tests pin what it refuses (production, localhost
// without --local, a missing target, credentials in the address) and that no secret reaches its output.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_HOSTS, parseTarget, readHostFile, verifyNotProduction, vercelDeploymentFacts } from '../scripts/lib/load-guard.ts';

const refused = (raw: string | undefined, local = false) => {
	try {
		parseTarget(raw, { local });
	} catch (error) {
		return (error as Error).message;
	}
	return null;
};

test('a missing or empty --target is refused', () => {
	assert.match(refused(undefined) ?? '', /--target is required/);
	assert.match(refused('') ?? '', /--target is required/);
	assert.match(refused('   ') ?? '', /--target is required/);
	assert.match(refused('not a url') ?? '', /isn't a web address/);
});

test('the production alias is refused however it is written', () => {
	assert.deepEqual([...PRODUCTION_HOSTS], ['aib-live.vercel.app']);
	for (const raw of [
		'https://aib-live.vercel.app',
		'https://AIB-LIVE.vercel.app/',
		'https://aib-live.vercel.app./',
		'https://aib-live.vercel.app:443',
		'https://aib-live.vercel.app:443/',
	]) assert.match(refused(raw) ?? '', /production/, raw);
	// Another preview of the same project is a different host and is not refused here (Vercel is asked next).
	assert.equal(refused('https://aib-live-git-load-test-someone.vercel.app'), null);
});

test('localhost needs --local, and --local allows nothing else', () => {
	for (const raw of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://[::1]:5173', 'http://app.localhost:5173']) {
		assert.match(refused(raw) ?? '', /needs --local/, `${raw} without --local`);
		assert.equal(refused(raw, true), null, `${raw} with --local`);
	}
	for (const raw of ['https://aib-live-abc.vercel.app', 'http://localhost.evil.com', 'http://127.0.0.1.nip.io', 'https://example.com']) {
		assert.match(refused(raw, true) ?? '', /--local is for localhost only/, `${raw} with --local`);
	}
});

test('a remote target must be an https vercel.app address with no credentials, path or query', () => {
	assert.match(refused('http://aib-live-abc.vercel.app') ?? '', /https/);
	assert.match(refused('https://example.com') ?? '', /vercel\.app/);
	assert.match(refused('https://aib-live-abc.vercel.app.evil.com') ?? '', /vercel\.app/);
	assert.match(refused('https://aib-live-abc.vercel.app/some/path') ?? '', /only the site's address/);
	assert.match(refused('https://aib-live-abc.vercel.app/?x=1') ?? '', /only the site's address/);
	assert.match(refused('https://user:hunter2@aib-live-abc.vercel.app') ?? '', /credentials/);
	assert.doesNotMatch(refused('https://user:hunter2@aib-live-abc.vercel.app') ?? '', /hunter2/, 'the refusal does not echo the password');
	assert.doesNotMatch(refused('https://user:hunter2@aib-live.vercel.app') ?? '', /hunter2/);
	assert.equal(parseTarget('https://aib-live-abc.vercel.app', { local: false }).url.origin, 'https://aib-live-abc.vercel.app');
});

test('Vercel is asked: a production deployment, a production alias, or no answer all refuse; a preview passes', async () => {
	const host = 'aib-live-abc.vercel.app';
	const ask = (facts: { target: string | null; aliases: string[] } | Error) => verifyNotProduction(host, async () => {
		if (facts instanceof Error) throw facts;
		return facts;
	});
	await assert.rejects(ask({ target: 'production', aliases: [] }), /production/);
	await assert.rejects(ask({ target: null, aliases: ['aib-live.vercel.app'] }), /production alias/);
	await assert.rejects(ask({ target: null, aliases: ['AIB-LIVE.vercel.app.'] }), /production alias/);
	await assert.rejects(ask(new Error('the Vercel CLI is not logged in')), /could not ask Vercel.*refusing/s);
	await ask({ target: null, aliases: ['aib-live-git-load.vercel.app'] });
	await ask({ target: 'preview', aliases: [] });
});

test('the Vercel lookup reads target and aliases from the deployment record and fails closed', async () => {
	const exec = (stdout: string, status = 0) => () => ({ status, stdout, stderr: '' });
	assert.deepEqual(await vercelDeploymentFacts('h.vercel.app', exec(JSON.stringify({ target: 'production', alias: ['a.com', 'b.vercel.app'] }))), { target: 'production', aliases: ['a.com', 'b.vercel.app'] });
	assert.deepEqual(await vercelDeploymentFacts('h.vercel.app', exec(JSON.stringify({ target: null }))), { target: null, aliases: [] });
	await assert.rejects(vercelDeploymentFacts('h.vercel.app', exec('{}', 1)), /Vercel/);
	await assert.rejects(vercelDeploymentFacts('h.vercel.app', exec('not json')), /Vercel/);
});

test('the host file must be private, and nothing from it reaches an error message', () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-load-'));
	const file = join(dir, 'host');
	writeFileSync(file, 'email=load@example.com\npassword=S3cretPassw0rd\n', { mode: 0o600 });
	assert.deepEqual(readHostFile(file), { email: 'load@example.com', password: 'S3cretPassw0rd' });

	chmodSync(file, 0o644);
	assert.throws(() => readHostFile(file), (error: Error) => /permissions/.test(error.message) && !/S3cret/.test(error.message));

	chmodSync(file, 0o600);
	writeFileSync(file, 'password=S3cretPassw0rd\n', { mode: 0o600 });
	assert.throws(() => readHostFile(file), (error: Error) => /email/.test(error.message) && !/S3cret/.test(error.message));
	assert.throws(() => readHostFile(join(dir, 'missing')), /host file/);
});

// ---- the command itself ----


const BYPASS = 'bypass-secret-VALUE-9876';
const LOGIN_PASSWORD = 'host-login-password-VALUE-5432';

function runCli(args: string[]) {
	const dir = mkdtempSync(join(tmpdir(), 'volley-load-cli-'));
	const file = join(dir, 'host');
	writeFileSync(file, `email=load@example.com\npassword=${LOGIN_PASSWORD}\n`, { mode: 0o600 });
	const run = spawnSync(process.execPath, ['scripts/load-test.ts', ...args, '--host-file', file], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS } });
	return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

test('the command refuses a missing target, the production alias, and localhost without --local, with exit 2 and no secret on screen', () => {
	for (const args of [[], ['--target', 'https://aib-live.vercel.app'], ['--target', 'http://localhost:5173'], ['--target', 'https://aib-live-abc.vercel.app', '--local']]) {
		const { status, output } = runCli(args);
		assert.equal(status, 2, args.join(' '));
		assert.match(output, /Refused:/);
		assert.ok(!output.includes(BYPASS) && !output.includes(LOGIN_PASSWORD), `${args.join(' ')} printed a secret`);
	}
});

test('the command refuses numbers outside its limits before sending anything', () => {
	for (const args of [['--phones', '100000'], ['--phones', '0'], ['--minutes', '600'], ['--replay-rate', '0.9'], ['--phones', 'many']]) {
		const { status, output } = runCli(['--target', 'http://localhost:5173', '--local', ...args]);
		assert.equal(status, 2, args.join(' '));
		assert.match(output, /must be a number from/);
	}
});

test('--check-only with --local passes the guards, says the secret is set without showing it, and sends nothing', () => {
	const { status, output } = runCli(['--target', 'http://localhost:5173', '--local', '--check-only']);
	assert.equal(status, 0);
	assert.match(output, /Guards passed/);
	assert.match(output, /bypass secret set/);
	assert.match(output, /Nothing was sent/);
	assert.ok(!output.includes(BYPASS) && !output.includes(LOGIN_PASSWORD));
});

test('a host file anyone else can read stops the command', () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-load-cli-'));
	const file = join(dir, 'host');
	writeFileSync(file, `email=a@example.com\npassword=${LOGIN_PASSWORD}\n`, { mode: 0o644 });
	chmodSync(file, 0o644);
	const run = spawnSync(process.execPath, ['scripts/load-test.ts', '--target', 'http://localhost:5173', '--local', '--host-file', file], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '' } });
	assert.equal(run.status, 2);
	assert.match(run.stderr, /permissions/);
	assert.ok(!`${run.stdout}${run.stderr}`.includes(LOGIN_PASSWORD));
});
