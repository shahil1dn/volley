// The real inputs for doctor: this folder's files, the network, the database and (only when
// asked) the linked Vercel project. Tests build a Ctx from fakes instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { SUPABASE_ROOT_CA } from '../../src/lib/server/supabase-ca.ts';
import type { Ctx } from './checks.ts';
import { realExec, vercelProbe } from './vercel.ts';

export const MIGRATIONS_DIR = 'db/migrations';

export const migrationFiles = (root: string): string[] => readdirSync(join(root, MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

export function readVercelLink(root: string): { projectId: string; orgId: string } | null {
	const file = join(root, '.vercel', 'project.json');
	if (!existsSync(file)) return null;
	try {
		const { projectId, orgId } = JSON.parse(readFileSync(file, 'utf8'));
		return projectId && orgId ? { projectId, orgId } : null;
	} catch {
		return null;
	}
}

export const reason = (error: unknown) => {
	const e = error as { code?: string; message?: string };
	return `${e.message ?? 'unknown error'}${e.code ? ` (${e.code})` : ''}`;
};

// A direct connection as the owner, from the given settings (not only the process environment).
export async function connectOwnerWith(env: Record<string, string | undefined>): Promise<pg.Client> {
	const url = new URL(env.POSTGRES_URL_NON_POOLING ?? '');
	url.searchParams.delete('sslmode');
	const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
	await client.connect();
	return client;
}

export function realContext(root: string, env: Record<string, string | undefined>, withVercel: boolean): { ctx: Ctx; close: () => Promise<void> } {
	const clients: pg.Client[] = [];
	let owner: pg.Client | null = null;
	let pooler: pg.Client | null = null;

	const connectOwner: Ctx['connectOwner'] = async () => {
		if (owner) return { ok: true };
		try {
			// Same as scripts/pg-connect.ts: encrypted, certificate not checked (a laptop script).
			const client = await connectOwnerWith(env);
			clients.push(client);
			owner = client;
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: reason(error) };
		}
	};

	const connectPooler: Ctx['connectPooler'] = async () => {
		if (pooler) return { ok: true };
		try {
			const url = new URL(env.POSTGRES_URL ?? '');
			url.searchParams.delete('sslmode');
			url.searchParams.delete('supa');
			// Exactly the app's settings (src/lib/server/db.ts): the pinned root CA, verification on.
			const client = new pg.Client({ connectionString: url.toString(), ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true }, connectionTimeoutMillis: 8000 });
			await client.connect();
			await client.query('select 1');
			clients.push(client);
			pooler = client;
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: reason(error) };
		}
	};

	const ctx: Ctx = {
		env,
		readFile: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null),
		migrationsOnDisk: () => migrationFiles(root),
		async fetchJson(url, headers) {
			const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
			return { status: response.status, body: await response.json().catch(() => null) };
		},
		async query(sql) {
			if (!owner && !pooler) {
				await connectOwner();
				if (!owner) await connectPooler();
			}
			const client = owner ?? pooler;
			if (!client) throw new Error('there is no database connection');
			// A read-only transaction: doctor can't change anything even by mistake.
			await client.query('begin read only');
			try {
				return (await client.query(sql)).rows;
			} finally {
				await client.query('rollback');
			}
		},
		connectOwner,
		connectPooler,
		vercel: withVercel ? vercelProbe(realExec(root), () => readVercelLink(root)) : undefined,
	};
	return { ctx, close: async () => void (await Promise.all(clients.map((client) => client.end().catch(() => undefined)))) };
}
