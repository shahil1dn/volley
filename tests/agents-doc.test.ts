// AGENTS.md is what a stranger's AI agent follows. It must not drift from the scripts it names, the
// checks doctor really runs, or the Deploy button's format.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDS } from '../scripts/lib/checks.ts';

const agents = readFileSync('AGENTS.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

test('every doctor check id appears in AGENTS.md, so a failing check can be looked up', () => {
	for (const id of IDS) assert.ok(agents.includes(`\`${id}\``), `AGENTS.md does not mention ${id}`);
});

test('every `npm run <script>` in AGENTS.md is a real script', () => {
	const named = [...agents.matchAll(/npm run ([a-z:-]+)/g)].map((match) => match[1]);
	assert.ok(named.includes('doctor') && named.includes('setup'));
	for (const name of named) assert.ok(scripts[name], `npm run ${name} does not exist`);
});

test('every flag AGENTS.md gives to setup or doctor is in that command\'s --help', () => {
	const help = (script: string) => spawnSync(process.execPath, [`scripts/${script}.ts`, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } }).stdout;
	for (const script of ['setup', 'doctor']) {
		const text = help(script);
		assert.ok(text.length > 100, `${script} --help printed nothing`);
		for (const [, flag] of [...agents.matchAll(new RegExp(`npm run ${script} -- ((?:--[a-z-]+ ?)+)`, 'g'))].flatMap((match) => match[1].trim().split(/\s+/).map((one) => [match[0], one])) as [string, string][]) {
			assert.ok(text.includes(flag), `AGENTS.md uses ${script} ${flag}, which --help does not list`);
		}
	}
	for (const flag of ['--force', '--reset-first-admin', '--dry-run', '--from-env-file', '--first-admin-email', '--push-vercel-env', '--vercel-protection', '--disable-signup']) {
		assert.ok(help('setup').includes(flag), `setup --help lost ${flag}`);
	}
});

test('AGENTS.md states the rules an agent must keep', () => {
	for (const rule of [/Never invent a value/, /Never print or paste a secret/, /--force/, /--reset-first-admin/, /\[ACCOUNT\]/, /exit/i, /human/i, /template/]) assert.match(agents, rule);
	assert.ok(agents.split(/\s+/).length < 1000, 'AGENTS.md should stay lean');
});

test('the Deploy button: vercel.com/new/clone with a repository placeholder and a Supabase integration store', () => {
	const href = /\[!\[Deploy with Vercel\]\(https:\/\/vercel\.com\/button\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/.exec(readme)?.[1];
	assert.ok(href, 'no Deploy with Vercel button in README.md');
	const url = new URL(href);
	assert.equal(url.origin + url.pathname, 'https://vercel.com/new/clone');
	assert.match(url.searchParams.get('repository-url') ?? '', /TODO/, 'the repository is a placeholder until the repo is public');
	assert.match(readme, /TODO \(Milestone 4 step 5\)/);
	const stores = JSON.parse(url.searchParams.get('stores') ?? 'null');
	assert.deepEqual(stores, [{ type: 'integration', integrationSlug: 'supabase', productSlug: 'supabase' }]);
	assert.match(readme, /AGENTS\.md/);
});
