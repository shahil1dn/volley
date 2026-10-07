// A file setup writes secrets to must be a real path inside the repo folder. This returns the path
// relative to `root` (the one form that is both written and asked about in git), or null when it
// is the folder itself, outside it, or not a plain relative path.
import { isAbsolute, relative, resolve } from 'node:path';

export function safeRelative(root: string, path: string): string | null {
	const rel = relative(root, resolve(root, path));
	if (rel === '' || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
	return rel;
}
