// What the guards check must be what is connected to. One function turns an address into the exact pg
// config; every owner connection uses its result and nothing parses the string a second time.
import fs from 'node:fs';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { addressConfig } from '../scripts/lib/connection-target.ts';
import { connectOwnerWith } from '../scripts/lib/context.ts';
import { connectAsOwner } from '../scripts/pg-connect.ts';
import { PRODUCTION_REF } from '../scripts/production-guard.ts';
import { skipWithoutDatabase as skip } from './db-helpers.ts';
import { HOSTILE } from './production-guard.test.ts';

test('addressConfig returns the parts pg connects to, with no connection string and no query', () => {
	const config = addressConfig('postgresql://postgres.abc:p%40ss@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require&application_name=x&host=elsewhere.example.com&sslcert=/nonexistent');
	assert.deepEqual({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database }, { host: 'aws-0-eu-west-2.pooler.supabase.com', port: 5432, user: 'postgres.abc', password: 'p@ss', database: 'postgres' });
	assert.equal((config as Record<string, unknown>).connectionString, undefined);
	assert.equal((config as Record<string, unknown>).application_name, undefined);
	assert.equal(config.ssl, undefined, 'the caller decides the TLS settings');
});

test('addressConfig reads the host exactly as new URL (and so pg) does: a tab inside it does not hide production', () => {
	const hostile = `postgresql://postgres:pw@db.${PRODUCTION_REF.slice(0, 6)}\t${PRODUCTION_REF.slice(6)}.supabase.co:5432/postgres?sslmode=require&application_name=volley x`;
	assert.equal(addressConfig(hostile).host, `db.${PRODUCTION_REF}.supabase.co`);
});

test('addressConfig never reads a file, and refuses an address with no host', () => {
	const reads = mock.method(fs, 'readFileSync', () => {
		throw new Error('a file was read');
	});
	try {
		addressConfig('postgresql://u:p@h.example.com/db?sslrootcert=/dev/stdin&sslcert=/nonexistent&sslkey=/nonexistent');
		assert.equal(reads.mock.callCount(), 0);
	} finally {
		reads.mock.restore();
	}
	assert.throws(() => addressConfig('postgresql://u:p@/db'), /no host/);
	assert.throws(() => addressConfig(''), /no host|address/);
});

test('every hostile production address is refused by the owner connection, and nothing connects', async () => {
	let made = 0;
	const client = mock.method(pg, 'Client', class {
		constructor() {
			made++;
		}
		connect = async () => undefined;
		end = async () => undefined;
	});
	try {
		for (const [label, address] of HOSTILE) {
			await assert.rejects(connectOwnerWith({ POSTGRES_URL_NON_POOLING: address }), /production database/, label);
		}
		assert.equal(made, 0, 'a client was made for a production address');
	} finally {
		client.mock.restore();
	}
});

test('the owner connections hand pg the parsed fields, never a string to parse again', async () => {
	const seen: Record<string, unknown>[] = [];
	const client = mock.method(pg, 'Client', class {
		constructor(config: Record<string, unknown>) {
			seen.push(config);
		}
		connect = async () => undefined;
		end = async () => undefined;
	});
	const address = 'postgresql://postgres.gzwzfjukswcifikbsufm:pw@aws-0-eu-west-2.pooler.supabase.com:5432/postgres?sslmode=require&application_name=volley x';
	const before = process.env.POSTGRES_URL_NON_POOLING;
	try {
		process.env.POSTGRES_URL_NON_POOLING = address;
		await connectOwnerWith({ POSTGRES_URL_NON_POOLING: address });
		await connectAsOwner();
	} finally {
		process.env.POSTGRES_URL_NON_POOLING = before;
		client.mock.restore();
	}
	assert.equal(seen.length, 2);
	for (const config of seen) {
		assert.equal(config.connectionString, undefined);
		assert.equal(config.host, 'aws-0-eu-west-2.pooler.supabase.com');
		assert.equal(config.user, 'postgres.gzwzfjukswcifikbsufm');
		assert.deepEqual(config.ssl, { rejectUnauthorized: false });
		assert.equal(config.application_name, undefined);
	}
});

test('the genuine test project is still reachable through both connectors', { skip }, async () => {
	const owner = await connectOwnerWith(process.env);
	try {
		assert.equal((await owner.query('select 1 as one')).rows[0].one, 1);
	} finally {
		await owner.end();
	}
	const shared = await connectAsOwner();
	try {
		assert.equal((await shared.query('select 1 as one')).rows[0].one, 1);
	} finally {
		await shared.end();
	}
});
