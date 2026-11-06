// The shape of a session, shared by the /decks form and its server action.
// The database repeats these limits in `start_session` (migrations 0014 and
// 0019) and is the last word; a test starts a session at each edge to keep the
// two in step.
export const MAX_ACTIVITIES = 10;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_PROMPT_CHARS = 140;
export const MAX_OPTION_CHARS = 80;
// A feedback form's rating questions (ADR-018); their scales are in feedback.ts.
export const MIN_FORM_QUESTIONS = 1;
export const MAX_FORM_QUESTIONS = 6;
export const MAX_FORM_QUESTION_CHARS = 80;

export const ACTIVITY_TYPES = [
	['word_cloud', 'Word cloud'],
	['poll', 'Poll'],
	['qna', 'Q&A'],
	['feedback', 'Feedback form'],
	['thanks', 'Thank you'],
] as const;
