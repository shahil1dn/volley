// The env file reader and writer: what setup writes must be what parse reads back, whatever the
// value holds, and writing one name must never disturb the rest of the file.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, quoteValue, setLine } from '../scripts/lib/env.ts';
import { writePrivate } from '../scripts/lib/private-file.ts';

// Values that have broken naive env writers: replacement patterns, quotes, comments, escapes.
const AWKWARD = ['p$&w', "p$'w", 'p$`w', '$1 and $$', 'a"b', "it's", 'a b  c', ' lead and trail ', 'x#y', 'x # y', 'a=b=c', 'back\\slash', 'a\\nb', 'tab\there', '', 'end\\', '"quoted"', "'single'", '${HOME}', '$(touch x)', 'ünï©ode ✓'];

test('every awkward value survives setLine then parse, in an empty file and over an existing line', () => {
	for (const value of AWKWARD) {
		assert.equal(parse(setLine('', 'SECRET', value)).SECRET, value, `empty file: ${JSON.stringify(value)}`);
		assert.equal(parse(setLine('SECRET=old\nOTHER=1\n', 'SECRET', value)).SECRET, value, `replace: ${JSON.stringify(value)}`);
		assert.equal(parse(setLine('SECRET=old\nOTHER=1\n', 'SECRET', value)).OTHER, '1');
	}
});

test('a "$&" in a value is stored literally: the replacement string is not interpreted', () => {
	assert.equal(setLine('POSTGRES_URL=x\n', 'POSTGRES_URL', 'p$&w'), "POSTGRES_URL='p$&w'\n");
	assert.equal(parse(setLine('A=1\nPOSTGRES_URL=x\n', 'POSTGRES_URL', "p$'w$`z")).POSTGRES_URL, "p$'w$`z");
});

test('a value that cannot be stored safely is refused with a message that does not contain it', () => {
	for (const value of ['line\nbreak', 'carriage\rreturn', `all ' three " kinds \` of quote`]) {
		assert.equal(quoteValue(value), null);
		assert.throws(() => setLine('A=1\n', 'SECRET', value), (error: Error) => /can't be stored safely/.test(error.message) && !error.message.includes(value));
	}
});

test('a name that is not a plain setting name is refused, and is never read as a pattern', () => {
	for (const name of ['A.B', 'A|B', '(A)', 'a lower', '1A', '', 'A\nB', 'A=B']) assert.throws(() => setLine('A=1\n', name, 'v'), /isn't a valid setting name/, name);
	// With a dot in the name unescaped, the pattern for "A.B" would also match the line for "AXB".
	assert.equal(setLine('AXB=keep\n', 'A_B', 'v'), 'AXB=keep\nA_B=v\n');
});

test('setLine leaves every other line byte for byte as it was, and replaces only the named one', () => {
	const text = '# notes\n\nexport KEEP=1\nTARGET=old # trailing\n  SPACED = 2\nLAST=z';
	const out = setLine(text, 'TARGET', 'new');
	assert.equal(out, '# notes\n\nexport KEEP=1\nTARGET=new\n  SPACED = 2\nLAST=z');
	assert.equal(setLine(text, 'SPACED', 'two'), '# notes\n\nexport KEEP=1\nTARGET=old # trailing\n  SPACED=two\nLAST=z');
});

test('an "export " prefix is kept when its line is replaced, and a commented-out name is not touched', () => {
	assert.equal(setLine('export TARGET=old\n', 'TARGET', 'new'), 'export TARGET=new\n');
	assert.equal(setLine('# TARGET=commented\n', 'TARGET', 'new'), '# TARGET=commented\nTARGET=new\n');
});

test('appending to a file with no trailing newline adds one first; an empty file gets just the line', () => {
	assert.equal(setLine('A=1', 'B', '2'), 'A=1\nB=2\n');
	assert.equal(setLine('A=1\n', 'B', '2'), 'A=1\nB=2\n');
	assert.equal(setLine('', 'B', '2'), 'B=2\n');
});

test('CRLF files stay CRLF: replaced lines, appended lines, and a second identical call changes nothing', () => {
	const text = 'A=1\r\nTARGET=old\r\nB=2\r\n';
	const replaced = setLine(text, 'TARGET', 'new');
	assert.equal(replaced, 'A=1\r\nTARGET=new\r\nB=2\r\n');
	assert.equal(setLine(replaced, 'TARGET', 'new'), replaced, 'idempotent');
	assert.equal(setLine(text, 'C', '3'), 'A=1\r\nTARGET=old\r\nB=2\r\nC=3\r\n');
	assert.equal(setLine('A=1\r\nB=2', 'C', '3'), 'A=1\r\nB=2\r\nC=3\r\n', 'no trailing newline in a CRLF file');
	assert.equal(parse(replaced).TARGET, 'new');
});

test('a name that appears twice ends up on one line, so the file says what parse reads', () => {
	const text = 'TARGET=first\nA=1\nTARGET=second\nexport TARGET=third\nB=2\n';
	assert.equal(parse(text).TARGET, 'third', 'the last one wins today');
	const out = setLine(text, 'TARGET', 'only');
	assert.equal((out.match(/TARGET=/g) ?? []).length, 1);
	assert.equal(parse(out).TARGET, 'only');
	assert.equal(parse(out).A, '1');
	assert.equal(parse(out).B, '2');
});

test('setLine twice with the same arguments is the same as once', () => {
	for (const value of AWKWARD) {
		const once = setLine('A=1\nSECRET=old', 'SECRET', value);
		assert.equal(setLine(once, 'SECRET', value), once, JSON.stringify(value));
	}
});

test('parse: comments, quotes, export, equals signs, CRLF, and empty values', () => {
	assert.deepEqual(parse('A=1\n# B=2\nC="x # y"\nD=p#q\nexport E=5\nF=a=b\nG=\n'), { A: '1', C: 'x # y', D: 'p', E: '5', F: 'a=b', G: '' });
	assert.deepEqual(parse('A=1\r\nB=two\r\n'), { A: '1', B: 'two' });
	assert.deepEqual(parse(''), {});
});

test('writePrivate replaces an existing world-readable file with a private one, by rename, leaving no temp file', () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-private-'));
	try {
		const file = join(dir, '.env.local');
		writeFileSync(file, 'old\n', { mode: 0o644 });
		chmodSync(file, 0o644);
		const before = statSync(file).ino;
		writePrivate(file, 'new\n', 0o600);
		assert.equal(readFileSync(file, 'utf8'), 'new\n');
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.notEqual(statSync(file).ino, before, 'a new file was renamed over the old one, the old one was never rewritten in place');
		assert.deepEqual(readdirSync(dir), ['.env.local']);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('writePrivate that fails leaves the existing file exactly as it was, and no temp file behind', { skip: process.getuid?.() === 0 }, () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-private-'));
	try {
		const file = join(dir, '.env.local');
		writeFileSync(file, 'precious\n', { mode: 0o600 });
		chmodSync(dir, 0o500); // no new files can be made here
		assert.throws(() => writePrivate(file, 'half-writt', 0o600));
		chmodSync(dir, 0o700);
		assert.equal(readFileSync(file, 'utf8'), 'precious\n');
		assert.deepEqual(readdirSync(dir), ['.env.local']);
	} finally {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
	assert.equal(existsSync(dir), false);
});

test('writePrivate whose rename fails removes its temp file and says why', () => {
	const dir = mkdtempSync(join(tmpdir(), 'volley-private-'));
	try {
		mkdirSync(join(dir, 'target'));
		writeFileSync(join(dir, 'target', 'inside'), 'x');
		assert.throws(() => writePrivate(join(dir, 'target'), 'text', 0o600));
		assert.deepEqual(readdirSync(dir), ['target'], 'no .tmp file left holding the text');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
