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
