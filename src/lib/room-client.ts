// What a phone needs to follow a room: the shape of the shared state, and the
// small rules for reading it and answering.

export type RoomState = {
	code: string;
	status: 'lobby' | 'live' | 'frozen' | 'ended';
	version: number;
	currentPosition: number;
	itemState: 'closed' | 'scheduled' | 'open' | 'revealed';
	opensAt: string | null;
	closesAt: string | null;
	serverNow: number;
	// The host's display name, for the projector's "… hosting" line; null if unset.
	hostName: string | null;
	item: { type: string; settings: Record<string, unknown> } | null;
	tallies: [string, number][];
	// A Q&A item's main list: [id, text, votes], most votes first.
	questions: [number, string, number][];
	// A Q&A item: the one question the host has put on the projector ([id, text,
	// votes], null if none), and how many others wait their turn (counted to 100).
	shown: [number, string, number] | null;
	waiting: number;
	players: [string, number][];
};

// The state is cached at the edge, so a poll can return an older copy than one
// already shown. Showing it would make the screen step backwards.
export function isNewer(current: RoomState | null, next: RoomState): boolean {
	return !current || next.version >= current.version;
}

// The vote count the server returned for this phone's own upvote, shown at once
// instead of waiting for the next poll. `at` is when that reply arrived.
export type OwnCount = { votes: number; at: number };

// A polled state can be older than the vote it follows (a request already in
// flight, or a copy the edge cache made a second ago), and showing its count
// would step the number back. So the reply's count stands until a state that
// was made AFTER the reply comes in. A cached copy was made `Age` seconds
// before it arrived; an uncached one was made after its request was sent.
export function stateMadeAt(sentAt: number, receivedAt: number, ageHeader: string | null): number {
	const ageSeconds = Number(ageHeader);
	return Number.isFinite(ageSeconds) && ageSeconds > 0 ? receivedAt - ageSeconds * 1000 : sentAt;
}

// Whether the phone should still show its own count rather than a polled one.
// It never outlives OWN_COUNT_MAX_MS, so a missing Age header can't pin it.
export const OWN_COUNT_MAX_MS = 10_000;
export function keepOwnCount(own: OwnCount, stateMadeAtMs: number, now: number): boolean {
	return stateMadeAtMs < own.at && now - own.at < OWN_COUNT_MAX_MS;
}

// Milliseconds to add to Date.now() to read the server's clock. A cached state
// was made `Age` seconds before it arrived, so its serverNow is that far behind.
export function serverClockOffset(serverNow: number, ageHeader: string | null, receivedAt: number): number {
	const ageSeconds = Number(ageHeader);
	return serverNow + (Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds * 1000 : 0) - receivedAt;
}

export const MESSAGES: Record<string, string> = {
	limit: "That's all your answers for this one.",
	closed: 'Answers are closed for this question.',
	frozen: 'The host has paused answers for a moment.',
	rate_limited: 'Lots of answers are arriving at once. Wait a few seconds, then send again.',
	invalid: 'Answers need 1 to 25 characters.',
	questionInvalid: 'Questions need 1 to 280 characters.',
	network: "That didn't send. Check your connection and send again. Your answer is kept.",
};

// crypto.randomUUID only exists on https and localhost; a phone testing the dev
// server over the local network has neither, so fall back to random bytes.
export function newSubmitId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// What this phone has sent, per item, kept on the phone (SPEC 13). Storage can
// be missing or full (private browsing), so every access may fail quietly: the
// page still works, it just forgets on reload.
export type SentByItem = Record<number, { words: string[]; left: number }>;

export function loadSent(code: string): SentByItem {
	try {
		return JSON.parse(localStorage.getItem(`volley:${code}`) ?? '{}');
	} catch {
		return {};
	}
}

export function saveSent(code: string, sent: SentByItem) {
	try {
		localStorage.setItem(`volley:${code}`, JSON.stringify(sent));
	} catch {
		// Nothing to do: see loadSent.
	}
}

// Which Q&A questions this phone has upvoted, kept like SentByItem. If it's
// lost, pressing Upvote again is harmless: the server sets the vote, so it
// never counts twice.
export function loadUpvoted(code: string): number[] {
	try {
		return JSON.parse(localStorage.getItem(`volley:${code}:upvoted`) ?? '[]');
	} catch {
		return [];
	}
}

export function saveUpvoted(code: string, ids: number[]) {
	try {
		localStorage.setItem(`volley:${code}:upvoted`, JSON.stringify(ids));
	} catch {
		// Nothing to do: see loadSent.
	}
}
