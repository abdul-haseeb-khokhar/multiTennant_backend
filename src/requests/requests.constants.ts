/**
 * A reference is read out on the phone and typed back, so it is stored trimmed and upper case: letters,
 * digits and `-`, 3 to 40 characters, starting with a letter or digit (the engine draws `AP-4K7Q2`,
 * `CB-…`). The same pattern is a CHECK constraint in the migration.
 */
export const REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

/** The engine's document of what the agent collected, serialised: more is refused (400), the database CHECK is the looser safety net. */
export const MAX_DETAILS_BYTES = 16_384;

/** The channels the engine reports (`chat` is the halted widget, L2). */
export const REQUEST_CHANNELS = ['voice', 'chat'] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];

export const MAX_SUMMARY_LENGTH = 1000;
export const MAX_NOTE_LENGTH = 500;
export const MAX_SUBMISSION_KEY_LENGTH = 200;

/** Internal calls per tenant and minute for the request and customer routes (a busy business takes a few calls a minute). */
export const INTERNAL_WRITES_PER_MINUTE = 600;

/** Longest search text on the staff list. */
export const MAX_SEARCH_LENGTH = 100;
