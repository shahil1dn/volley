import { sessionIssuedAt } from './host-session.ts';

// What a host sign-in needs from outside, so the order of steps can be tested.
export type SignInDeps = {
	now(): number; // unix seconds
	findUserId(email: string): Promise<string | null>;
	readProfile(userId: string): Promise<{ sessionsValidAfter: number } | null>;
	checkPassword(email: string, password: string): Promise<{ status: 'ok'; userId: string } | { status: 'wrong' | 'unavailable' }>;
};

export type SignInResult =
	| { status: 'ok'; userId: string; issuedAt: number }
	| { status: 'wrong_password' }
	| { status: 'not_host' }
	| { status: 'unavailable' };

// The host's reset stamp is read BEFORE the password is checked, and the session
// is stamped no later than that moment. A reset that lands while the password
// is being checked then ends this session too: reading the stamp afterwards
// would hand the old password a session newer than the reset (ADR-011).
//
// The password is checked whether or not the email belongs to a host, so a
// wrong password gets the same answer for every email, and "not a host" is
// only ever said to someone who proved the password.
export async function signInHost(deps: SignInDeps, email: string, password: string): Promise<SignInResult> {
	let startedAt: number;
	let hostId: string | null = null;
	let sessionsValidAfter = 0;
	try {
		startedAt = deps.now();
		const userId = await deps.findUserId(email);
		const profile = userId ? await deps.readProfile(userId) : null;
		if (userId && profile) {
			hostId = userId;
			sessionsValidAfter = profile.sessionsValidAfter;
		}
	} catch {
		return { status: 'unavailable' };
	}

	const checked = await deps.checkPassword(email, password).catch(() => ({ status: 'unavailable' as const }));
	if (checked.status !== 'ok') return { status: checked.status === 'wrong' ? 'wrong_password' : 'unavailable' };
	if (hostId === null || checked.userId !== hostId) return { status: 'not_host' };
	return { status: 'ok', userId: hostId, issuedAt: sessionIssuedAt(startedAt, sessionsValidAfter) };
}
