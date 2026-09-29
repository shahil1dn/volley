// Shared by the database tests. Not a test file itself, so the runner skips it.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { makeJoinCode } from '../src/lib/server/host-token.ts';

export const skipWithoutDatabase = process.env.POSTGRES_URL_NON_POOLING ? false : 'no database in .env.local';

export async function inRolledBackTransaction(db: pg.Client, work: () => Promise<void>) {
	await db.query('begin');
	try {
		await work();
	} finally {
		await db.query('rollback');
	}
}

export type TestRun = { userId: string; deckId: string; itemId: string; runId: string; code: string };

// A host, a one-item word-cloud deck and a live run with the item open.
// Deleting the user cascades through everything created here.
export async function makeRun(
	db: pg.Client,
	options: {
		status?: string;
		itemState?: string;
		opensAt?: Date | null;
		closesAt?: Date | null;
		settings?: object;
		itemType?: string;
	} = {},
): Promise<TestRun> {
	const userId = randomUUID();
	await db.query('insert into auth.users (id) values ($1)', [userId]);
	await db.query('insert into public.hosts (user_id, email) values ($1, $2)', [userId, `test-${userId}@example.invalid`]);
	const deckId = (
		await db.query('insert into public.decks (host_id, title) values ($1, $2) returning id', [userId, 'Test deck'])
	).rows[0].id;
	const itemId = (
		await db.query(
			'insert into public.deck_items (deck_id, position, type, settings) values ($1, 0, $2, $3) returning id',
			[deckId, options.itemType ?? 'word_cloud', options.settings ?? {}],
		)
	).rows[0].id;
	const code = makeJoinCode();
	const runId = (
		await db.query(
			`insert into public.runs (deck_id, code, status, item_state, opens_at, closes_at)
			 values ($1, $2, $3, $4, $5, $6) returning id`,
			[deckId, code, options.status ?? 'live', options.itemState ?? 'open', options.opensAt ?? null, options.closesAt ?? null],
		)
	).rows[0].id;
	return { userId, deckId, itemId, runId, code };
}

export type SubmitResult = { status: string; left?: number };

export async function submit(
	db: pg.Client,
	code: string,
	participantId: string,
	submitId: string,
	value: string,
	ipHash = 'test-ip',
): Promise<SubmitResult> {
	const { rows } = await db.query('select public.submit_answer($1, $2, $3, $4, $5) as result', [
		code,
		participantId,
		submitId,
		value,
		ipHash,
	]);
	return rows[0].result;
}

export type ScanCounts = Record<string, { sequential: number; index: number }>;

// Scans this transaction has made so far on each table, from Postgres's own
// per-transaction statistics. Measures what a function really executed,
// rather than EXPLAIN on a copy of its SQL that could drift from it.
export async function scanCounts(db: pg.Client, tables: string[]): Promise<ScanCounts> {
	const { rows } = await db.query(
		`select relname, seq_scan, coalesce(idx_scan, 0) as idx_scan
		 from pg_stat_xact_user_tables where schemaname = 'public' and relname = any($1)`,
		[tables],
	);
	return Object.fromEntries(
		rows.map((row) => [row.relname, { sequential: Number(row.seq_scan), index: Number(row.idx_scan) }]),
	);
}
