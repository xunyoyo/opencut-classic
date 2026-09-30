export const DEFAULT_WORDS_PER_CAPTION = 3;
export const MIN_CAPTION_DURATION_SECONDS = 0.8;

/**
 * Per-caption budget for scripts written without word separators.
 *
 * `DEFAULT_WORDS_PER_CAPTION` cannot serve both scripts: it counts *words*, and
 * a CJK line has no spaces, so the whole line collapses into a single token and
 * the 0.8s display floor stretches it across the entire segment. Counting
 * characters instead keeps a Chinese caption at a readable width — the 6-10
 * character range viewers are used to — without touching the Latin default.
 */
export const DEFAULT_CHARS_PER_CAPTION = 9;

/**
 * Captions narrower than this many characters (a latin word counts as three)
 * are folded into a neighbour when one is close enough. The recogniser splits
 * off drawn-out particles on their own — a lone 「了」 — and showing those as
 * captions of their own is what reads as broken. Distinct from
 * `MIN_CAPTION_DURATION_SECONDS`, which only stretches how long a caption stays
 * on screen and never changes its text.
 */
export const MIN_CAPTION_CHARS = 3;

/** Silence at least this long counts as a clause break, like a comma. */
export const CAPTION_CLAUSE_PAUSE_SECONDS = 0.3;

/**
 * Silence longer than this always ends a caption: joining text across it would
 * put words on screen long before, or long after, they are spoken.
 */
export const CAPTION_MAX_JOIN_GAP_SECONDS = 1;

/**
 * Shortest time a caption stays on screen when nothing follows it closely.
 * Only matters when timings leave no room at all — a zero-length caption is
 * never shown, which loses the text. Never pushes a later caption back.
 */
export const CAPTION_MIN_VISIBLE_SECONDS = 0.3;
