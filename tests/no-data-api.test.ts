// ADR-006: the app reaches the database only through src/lib/server/db.ts, over
// the pooler. A call through Supabase's Data API (supabase-js `.rpc(` or
// `.from('table')`) would quietly bring back the ~44 calls/s ceiling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => (entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)])),
	);
	return nested.flat().filter((file) => /\.(ts|js|svelte)$/.test(file));
}

test('no app code calls the database through the Data API', async () => {
	const offenders: string[] = [];
	for (const file of await sourceFiles('src')) {
		const lines = (await readFile(file, 'utf8')).split('\n');
		lines.forEach((line, i) => {
			if (/\.rpc\(|\.from\(\s*['"]/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});
