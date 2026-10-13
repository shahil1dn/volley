// The shape of a session, shared by the /decks form and its server action.
// The database repeats these limits in `start_session` (migration 0014) and
// is the last word; a test starts a session at each edge to keep the two in
// step.
export const MAX_ACTIVITIES = 10;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_PROMPT_CHARS = 140;
export const MAX_OPTION_CHARS = 80;

export const ACTIVITY_TYPES = [
	['word_cloud', 'Word cloud'],
	['poll', 'Poll'],
	['qna', 'Q&A'],
	['thanks', 'Thank you'],
] as const;
