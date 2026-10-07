// AGENTS.md is what a stranger's AI agent follows. It must not drift from the scripts it names, the
// checks doctor really runs, or the Deploy button's format.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, IDS, runChecks, type Ctx } from '../scripts/lib/checks.ts';

const agents = readFileSync('AGENTS.md', 'utf8');
// A flag as a whole word: --force must not be satisfied by --force-everything.
const hasFlag = (text: string, flag: string) => new RegExp(`(^|[\\s\`'"(,])${flag}(?![A-Za-z0-9-])`, 'm').test(text);
const readme = readFileSync('README.md', 'utf8');
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;

// What doctor really emits, from a stub context: a check added to CHECKS without an id (or with a stale one) shows up here.
const stub: Ctx = {
	env: {}, readFile: () => null, migrationsOnDisk: () => [], fetchJson: async () => ({ status: 200, body: {} }),
	query: async () => [], connectOwner: async () => ({ ok: false, reason: 'stub' }), connectPooler: async () => ({ ok: false, reason: 'stub' }),
	vercel: { linked: () => null, envNames: async () => ({}), protection: async () => null },
};

test('the ids doctor emits are exactly the ones it lists, one per check', async () => {
	const emitted = (await runChecks(stub)).map((check) => check.id);
	assert.equal(emitted.length, CHECKS.length, 'a check returned no result');
	assert.equal(new Set(emitted).size, emitted.length, 'two checks share an id');
	assert.deepEqual(emitted, IDS, 'IDS (used for a crashed check) has drifted from what the checks emit');
});

test('every doctor check id appears in AGENTS.md, so a failing check can be looked up', async () => {
	for (const { id } of await runChecks(stub)) assert.ok(agents.includes(`\`${id}\``), `AGENTS.md does not mention ${id}`);
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
			assert.ok(hasFlag(text, flag), `AGENTS.md uses ${script} ${flag}, which --help does not list`);
		}
	}
	for (const flag of ['--force', '--reset-first-admin', '--dry-run', '--from-env-file', '--first-admin-email', '--push-vercel-env', '--vercel-protection', '--disable-signup']) {
		assert.ok(hasFlag(help('setup'), flag), `setup --help lost ${flag}`);
	}
});

test('AGENTS.md states the rules an agent must keep', () => {
	for (const rule of [/Never invent a value/, /Never print or paste a secret/, /--force/, /--reset-first-admin/, /\[ACCOUNT\]/, /exit/i, /human/i, /template/, /override any `run` step/, /`confirm`/, /Never open, `cat` or read `\.env\.local`/, /Act only on `fail` and `warn`/, /Node 22\.18/, /npm i -g vercel/]) assert.match(agents, rule);
	assert.ok(agents.split(/\s+/).length < 1000, 'AGENTS.md should stay lean');
});

test('the Deploy button is prepared in the right format but NOT live while its repository is a placeholder', () => {
	const live = readme.replace(/<!--[\s\S]*?-->/g, '');
	assert.doesNotMatch(live, /TODO-OWNER|TODO-REPO/, 'a live link to a repository nobody owns yet');
	const liveButton = /\[!\[Deploy with Vercel\]\([^)]*\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/.exec(live)?.[1];
	const prepared = /\[!\[Deploy with Vercel\]\(https:\/\/vercel\.com\/button\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/.exec(readme)?.[1];
	const href = liveButton ?? prepared;
	assert.ok(href, 'no Deploy with Vercel button in README.md, live or prepared');
	const url = new URL(href);
	assert.equal(url.origin + url.pathname, 'https://vercel.com/new/clone');
	assert.ok(url.searchParams.get('repository-url'), 'repository-url is required');
	const stores = JSON.parse(url.searchParams.get('stores') ?? 'null');
	assert.deepEqual(stores, [{ type: 'integration', integrationSlug: 'supabase', productSlug: 'supabase' }]);
	if (!liveButton) assert.match(readme, /Milestone 4 step 5/, 'the prepared button must say when it goes live');
	assert.match(readme, /AGENTS\.md/);
});

test('the trial plan uses a throwaway Vercel project, a record file that exists, and the merged main', () => {
	const trial = readFileSync('docs/trial-A15.md', 'utf8');
	const record = readFileSync('docs/trial-A15-record.md', 'utf8');
	assert.match(trial, /throwaway project named `volley-trial`/);
	assert.match(trial, /Merge `m4-agents` to `main` first/);
	assert.match(trial, /docs\/trial-A15-record\.md/);
	assert.match(record, /\| # \| Where/);
	const brief = trial.slice(trial.indexOf('## The brief'), trial.indexOf('## Pass'));
	assert.doesNotMatch(brief, /Do not print|Do not use `--force`|one step at a time|secret/i, 'the brief must not hand the agent the rules AGENTS.md is being tested on');
});
