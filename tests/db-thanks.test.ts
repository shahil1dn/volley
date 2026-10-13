// The thank-you slide (migration 0018): a session may hold one, it keeps its
// message like a question, and nothing can be answered on it. Every test is
// rolled back.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { inRolledBackTransaction, makeRun, skipWithoutDatabase as skip, submit } from './db-helpers.ts';

let db: pg.Client;
before(async () => {
	if (!skip) db = await connectAsOwner();
});
after(async () => {
	await db?.end();
});

async function start(hostId: string, items: object[]) {
	return (await db.query('select public.start_session($1, $2) as result', [hostId, JSON.stringify(items)])).rows[0].result;
}

async function act(hostId: string, code: string, action: string) {
	return (await db.query('select public.host_action($1, $2, $3, null) as result', [hostId, code, action])).rows[0].result;
}

test('a session can end on a thank-you slide, stored with its message like a question', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const started = await start(host.userId, [
			{ type: 'word_cloud', prompt: 'One word?' },
			{ type: 'thanks', prompt: '  Thank you for joining  ' },
		]);
		assert.equal(started.status, 'ok');
		const { rows } = await db.query(
			`select i.type, i.settings from public.deck_items i join public.runs r on r.deck_id = i.deck_id
			 where r.code = $1 order by i.position`,
			[started.code],
		);
		assert.deepEqual(rows.map((row) => row.type), ['word_cloud', 'thanks']);
		assert.deepEqual(rows[1].settings, { prompt: 'Thank you for joining' });
	});
});

const first = { type: 'word_cloud', prompt: 'One word?' };

test("a thank-you slide's message is 1 to 140 characters, like a question", { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		assert.equal((await start(host.userId, [first, { type: 'thanks', prompt: '   ' }])).status, 'invalid');
		assert.equal((await start(host.userId, [first, { type: 'thanks', prompt: 'x'.repeat(141) }])).status, 'invalid');
		assert.equal((await start(host.userId, [first, { type: 'thanks', prompt: 'x'.repeat(140) }])).status, 'ok');
	});
});

test('a session cannot start with a thank-you slide, alone or before other activities', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		assert.equal((await start(host.userId, [{ type: 'thanks', prompt: 'Thanks' }])).status, 'invalid');
		assert.equal((await start(host.userId, [{ type: 'thanks', prompt: 'Thanks' }, first])).status, 'invalid');
	});
});

test('answers never open on a thank-you slide, so no phone can answer it', { skip }, async () => {
	await inRolledBackTransaction(db, async () => {
		const host = await makeRun(db);
		const { code } = await start(host.userId, [
			{ type: 'word_cloud', prompt: 'One word?' },
			{ type: 'thanks', prompt: 'Thank you' },
		]);
		assert.equal((await act(host.userId, code, 'open')).status, 'ok');
		assert.equal((await act(host.userId, code, 'next')).status, 'ok');
		assert.equal((await act(host.userId, code, 'open')).status, 'illegal');
		const run = (await db.query('select status, item_state, current_position from public.runs where code = $1', [code])).rows[0];
		assert.deepEqual([run.status, run.item_state, run.current_position], ['live', 'closed', 1]);
		assert.notEqual((await submit(db, code, crypto.randomUUID(), crypto.randomUUID(), 'hello')).status, 'ok');
	});
});
