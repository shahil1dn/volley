// Migration 0008 must apply whether or not pg_cron is already installed. A person who enables pg_cron
// in the Supabase dashboard first (which doctor tells them to do) has it installed, and Supabase's
// own event trigger on CREATE EXTENSION then fails with "grant options cannot be granted back to your
// own grantor", even for `create extension if not exists`. So the migration only creates it when missing.
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectOwnerWith } from '../scripts/lib/context.ts';
import { inRolledBackTransaction, skipWithoutDatabase as skip } from './db-helpers.ts';

const file = readdirSync('db/migrations').find((name) => name.startsWith('0008')) ?? 'missing';
const sql = readFileSync(`db/migrations/${file}`, 'utf8');

test('0008 never runs CREATE EXTENSION while pg_cron already exists', () => {
	const statements = sql.replace(/^\s*--.*$/gm, '');
	const create = /create extension[^;]*;/i.exec(statements)?.[0] ?? '';
	assert.match(statements, /if not exists \(select 1 from pg_extension where extname = 'pg_cron'\)/i, 'the create must be guarded by a look at pg_extension');
	assert.doesNotMatch(statements.replace(/do \$\$[\s\S]*?\$\$;/i, ''), /create extension/i, 'no CREATE EXTENSION outside the guard');
	assert.match(create, /pg_cron/);
});

test('0008 applies over an installed pg_cron and leaves the purge job scheduled (rolled back)', { skip }, async () => {
	const db = await connectOwnerWith(process.env);
	try {
		const installed = (await db.query("select 1 from pg_extension where extname = 'pg_cron'")).rowCount;
		assert.equal(installed, 1, 'this test needs pg_cron installed on the test project');
		await inRolledBackTransaction(db, async () => {
			await db.query(sql);
			const job = (await db.query("select schedule, command, active from cron.job where jobname = 'volley-purge-expired'")).rows[0];
			assert.deepEqual(job, { schedule: '0 * * * *', command: 'select public.purge_expired()', active: true });
		});
	} finally {
		await db.end();
	}
});
