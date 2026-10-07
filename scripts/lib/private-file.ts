// Writes a file that holds secrets so it is never readable by anyone else, not even for a moment,
// and never half-written: a temp file made private from the start, then renamed over the target.
import { randomBytes } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writePrivate(file: string, text: string, mode = 0o600): void {
	// Named after the target so the same .gitignore patterns cover a temp left by a crash.
	const temp = join(dirname(file), `${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
	try {
		writeFileSync(temp, text, { mode, flag: 'wx' });
		chmodSync(temp, mode);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
