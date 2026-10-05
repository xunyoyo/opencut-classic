import type { TranscriptionSegment, TranscriptionWord } from "./types";
import { CAPTION_MAX_JOIN_GAP_SECONDS } from "./caption-defaults";

/**
 * One entry of the Transformers.js Whisper pipeline's `chunks`. The library
 * types the timestamp as `[number, number]`, but either side can come back
 * null at runtime: the end when a window is cut mid-sentence, the start when
 * the model never emitted the opening timestamp token.
 */
export interface WhisperChunk {
	text: string;
	timestamp?: readonly (number | null | undefined)[] | null;
}

/** Whisper reads at most 30 seconds of audio per pass. */
export const WHISPER_WINDOW_SECONDS = 30;
/**
 * Windows are cut at the quietest moment in their last stretch, so a cut lands
 * in a pause rather than through a word.
 */
const WINDOW_CUT_SEARCH_SECONDS = 10;
const WINDOW_CUT_FRAME_SECONDS = 0.02;

/**
 * RMS below this counts as silence when looking for where speech begins
 * (about -40 dBFS). Background music or room noise above it simply means no
 * leading silence is found, which leaves the timings as they were.
 */
const SILENCE_RMS = 0.01;

/** Seconds per han character / latin word, only for guessing a missing time. */
const ESTIMATED_SECONDS_PER_CJK_CHAR = 0.25;
const ESTIMATED_SECONDS_PER_LATIN_WORD = 0.35;
const MIN_ESTIMATED_SECONDS = 0.2;

/**
 * Whisper's word alignment hands the silence before a word to that word — the
 * first word of a clip routinely comes back as 0s→3.3s when speech starts at
 * 3s — or the pause after a word to the word itself. A word lasting longer
 * than this many times what it should take, and over the floor, is cut back.
 */
const OVERLONG_WORD_FACTOR = 3;
const OVERLONG_WORD_FLOOR_SECONDS = 1;

/**
 * A segment built from word timings is closed after this long even without a
 * sentence mark or a pause, so one runaway sentence cannot become one segment.
 */
const MAX_WORD_SEGMENT_SECONDS = 15;

const SENTENCE_END_REGEX = /(?:[。！？!?；;…]|\.)["'”’」』)）]*$/;
/** Any trailing mark: the speaker may pause after it. */
const TRAILING_MARK_REGEX = /[^\p{L}\p{N}\s]$/u;
const HAS_CONTENT_REGEX = /[\p{L}\p{N}]/u;
const CJK_CHAR_REGEX =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const LATIN_WORD_REGEX = /[\p{L}\p{N}]+/gu;

interface TimedText {
	text: string;
	start: number;
	end: number;
}

function knownTime(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

function estimateDuration({ text }: { text: string }): number {
	const cjk = text.match(CJK_CHAR_REGEX)?.length ?? 0;
	const latin =
		text.replace(CJK_CHAR_REGEX, " ").match(LATIN_WORD_REGEX)?.length ?? 0;
	return Math.max(
		MIN_ESTIMATED_SECONDS,
		cjk * ESTIMATED_SECONDS_PER_CJK_CHAR +
			latin * ESTIMATED_SECONDS_PER_LATIN_WORD,
	);
}

/**
 * Splits audio into windows of at most `WHISPER_WINDOW_SECONDS`, each cut at
 * the quietest frame of its last stretch.
 *
 * The pipeline's own chunking (`chunk_length_s` + `stride_length_s`) can not
 * be used with word timestamps: measured with Transformers.js 3.8.1, merging
 * the overlapping windows silently dropped whole sentences — 17 of 52 seconds
 * of speech went missing. Cutting in pauses needs no overlap to merge.
 */
export function planTranscriptionWindows({
	audio,
	sampleRate,
	windowSeconds = WHISPER_WINDOW_SECONDS,
}: {
	audio: Float32Array;
	sampleRate: number;
	windowSeconds?: number;
}): { start: number; end: number }[] {
	const maxLength = Math.floor(windowSeconds * sampleRate);
	const searchLength = Math.min(
		Math.floor(WINDOW_CUT_SEARCH_SECONDS * sampleRate),
		Math.floor(maxLength / 2),
	);
	const frameLength = Math.max(
		1,
		Math.floor(WINDOW_CUT_FRAME_SECONDS * sampleRate),
	);

	const windows: { start: number; end: number }[] = [];
	let start = 0;
	while (audio.length - start > maxLength) {
		const searchEnd = start + maxLength;
		let cut = searchEnd;
		let quietest = Number.POSITIVE_INFINITY;
		for (
			let frame = searchEnd - searchLength;
			frame + frameLength <= searchEnd;
			frame += frameLength
		) {
			let energy = 0;
			for (let index = frame; index < frame + frameLength; index++) {
				energy += audio[index] * audio[index];
			}
			if (energy < quietest) {
				quietest = energy;
				cut = frame + Math.floor(frameLength / 2);
			}
		}
		windows.push({ start, end: cut });
		start = cut;
	}
	if (audio.length > start || windows.length === 0) {
		windows.push({ start, end: audio.length });
	}
	return windows;
}

/**
 * How long the audio stays silent before anything is heard. Segment timings
 * need it: Whisper starts its first segment at 0 however late the speech
 * begins, which is what put local captions at the very start of the clip.
 */
export function leadingSilenceSeconds({
	audio,
	sampleRate,
}: {
	audio: Float32Array;
	sampleRate: number;
}): number {
	const frameLength = Math.max(
		1,
		Math.floor(WINDOW_CUT_FRAME_SECONDS * sampleRate),
	);
	for (let frame = 0; frame < audio.length; frame += frameLength) {
		const end = Math.min(audio.length, frame + frameLength);
		let energy = 0;
		for (let index = frame; index < end; index++) {
			energy += audio[index] * audio[index];
		}
		if (Math.sqrt(energy / (end - frame)) >= SILENCE_RMS) {
			return frame / sampleRate;
		}
	}
	return audio.length / sampleRate;
}

/**
 * Shifts one window's word chunks onto the clip's clock and cuts back words
 * that swallowed a pause (see `OVERLONG_WORD_FACTOR`). A word that ends a
 * clause keeps its start and loses the pause after it; the first word of a
 * window, or a word after a clause mark, keeps its end and loses the silence
 * before it. Unknown times stay unknown for `resolveChunkTimes`.
 */
export function placeWindowWords({
	chunks,
	offsetSeconds,
}: {
	chunks: WhisperChunk[];
	offsetSeconds: number;
}): WhisperChunk[] {
	return chunks.map((chunk, index) => {
		let start = knownTime(chunk.timestamp?.[0]);
		let end = knownTime(chunk.timestamp?.[1]);
		if (start !== null && end !== null) {
			const word = chunk.text.trim();
			const estimate = estimateDuration({ text: word });
			const limit = Math.max(
				OVERLONG_WORD_FLOOR_SECONDS,
				estimate * OVERLONG_WORD_FACTOR,
			);
			if (end - start > limit) {
				const previous = chunks[index - 1]?.text.trim() ?? "";
				const startsClause =
					index === 0 || TRAILING_MARK_REGEX.test(previous);
				if (!TRAILING_MARK_REGEX.test(word) && startsClause) {
					start = end - estimate;
				} else {
					end = start + estimate;
				}
			}
		}
		return {
			text: chunk.text,
			timestamp: [
				start === null ? null : start + offsetSeconds,
				end === null ? null : end + offsetSeconds,
			],
		};
	});
}

/**
 * Whether word timings are worth placing captions on. Some exports align
 * nothing — whisper-medium put every English word at 29.76s — and captions
 * built on that would be worse than the segment timings.
 */
export function wordTimingsLookUsable({
	chunks,
	audioDuration,
}: {
	chunks: WhisperChunk[];
	audioDuration: number;
}): boolean {
	const words = chunks.filter((chunk) => HAS_CONTENT_REGEX.test(chunk.text));
	if (words.length === 0) return false;

	let timed = 0;
	let collapsed = 0;
	const starts = new Set<number>();
	for (const word of words) {
		const start = knownTime(word.timestamp?.[0]);
		const end = knownTime(word.timestamp?.[1]);
		if (start === null || end === null) continue;
		if (start > audioDuration + 1) return false;
		timed += 1;
		starts.add(start);
		if (end <= start) collapsed += 1;
	}
	if (timed < words.length / 2) return false;
	if (collapsed > timed / 2) return false;
	return words.length < 3 || starts.size > 1;
}

/**
 * Turns the pipeline's chunks into times that are all known and in order.
 *
 * A missing time is never read as 0 — that is what stacked local captions at
 * the very start of the timeline. A missing start takes over where the chunk
 * before ended; a missing end runs to where the next chunk starts, but no
 * longer than the text would take to say, so a trailing silence is not
 * covered. Starts never go backwards and a chunk never overlaps the next.
 */
export function resolveChunkTimes({
	chunks,
	audioDuration,
}: {
	chunks: WhisperChunk[];
	audioDuration?: number;
}): TimedText[] {
	const raw = chunks.map((chunk) => ({
		text: chunk.text,
		start: knownTime(chunk.timestamp?.[0]),
		end: knownTime(chunk.timestamp?.[1]),
	}));
	const limit =
		audioDuration !== undefined && audioDuration > 0
			? audioDuration
			: Number.POSITIVE_INFINITY;

	/** The next time known to come after chunk `index`, if any. */
	const nextKnownTime = (index: number): number | null => {
		for (let next = index + 1; next < raw.length; next++) {
			const time = raw[next].start ?? raw[next].end;
			if (time !== null) return time;
		}
		return null;
	};

	const resolved: TimedText[] = [];
	for (let index = 0; index < raw.length; index++) {
		const chunk = raw[index];
		const previous = resolved[resolved.length - 1];
		const estimate = estimateDuration({ text: chunk.text });

		let start = chunk.start;
		if (start === null) {
			if (previous) {
				start = previous.end;
			} else {
				// The very first chunk: back off from whatever is known after it.
				const anchor = chunk.end ?? nextKnownTime(index);
				start = anchor === null ? 0 : Math.max(0, anchor - estimate);
			}
		}
		if (previous) start = Math.max(start, previous.start);
		start = Math.min(start, limit);

		let end = chunk.end;
		if (end === null || end < start) {
			const next = nextKnownTime(index);
			end = start + estimate;
			if (next !== null && next >= start) end = Math.min(end, next);
		}
		end = Math.min(end, limit);

		// Whisper sometimes lets a chunk run past the start of the next one.
		if (previous && previous.end > start) {
			previous.end = Math.max(previous.start, start);
		}
		resolved.push({ text: chunk.text, start, end: Math.max(start, end) });
	}
	return resolved;
}

/**
 * Segment-level output (`return_timestamps: true`): one chunk per segment.
 * `speechStart` (see `leadingSilenceSeconds`) moves the first segment off the
 * 0 Whisper gives it, as long as the segment still ends after it.
 */
export function segmentsFromSegmentChunks({
	chunks,
	audioDuration,
	speechStart = 0,
}: {
	chunks: WhisperChunk[];
	audioDuration?: number;
	speechStart?: number;
}): TranscriptionSegment[] {
	const segments = resolveChunkTimes({ chunks, audioDuration })
		.filter((chunk) => chunk.text.trim())
		.map(({ text, start, end }) => ({ text: text.trim(), start, end }));
	const first = segments[0];
	if (first && first.start < speechStart && speechStart < first.end) {
		first.start = speechStart;
	}
	return segments;
}

/**
 * Word-level output (`return_timestamps: "word"`): every chunk is one word —
 * for Chinese one or two characters, with the punctuation stuck to the word
 * before it ("很好,"). Words are grouped into segments at sentence marks and
 * at pauses a caption must not span, and each segment keeps its words so
 * captions are placed on the real timing.
 */
export function segmentsFromWordChunks({
	chunks,
	audioDuration,
}: {
	chunks: WhisperChunk[];
	audioDuration?: number;
}): TranscriptionSegment[] {
	const segments: TranscriptionSegment[] = [];
	let text = "";
	let words: TranscriptionWord[] = [];
	let segmentStart = 0;
	let segmentEnd = 0;

	const flush = () => {
		const trimmed = text.trim();
		if (trimmed && words.length > 0) {
			segments.push({
				text: trimmed,
				start: segmentStart,
				end: segmentEnd,
				words,
			});
		}
		text = "";
		words = [];
	};

	for (const chunk of resolveChunkTimes({ chunks, audioDuration })) {
		const word = chunk.text.trim();
		if (!word) continue;

		// A mark on its own ("，") belongs to the text but carries no timing.
		if (!HAS_CONTENT_REGEX.test(word)) {
			if (words.length > 0) {
				text += chunk.text;
				if (SENTENCE_END_REGEX.test(word)) flush();
			}
			continue;
		}

		if (words.length > 0) {
			const gap = chunk.start - segmentEnd;
			const tooLong = chunk.end - segmentStart > MAX_WORD_SEGMENT_SECONDS;
			if (gap > CAPTION_MAX_JOIN_GAP_SECONDS || tooLong) flush();
		}
		if (words.length === 0) segmentStart = chunk.start;

		text += chunk.text;
		words.push({ word, start: chunk.start, end: chunk.end });
		segmentEnd = chunk.end;
		if (SENTENCE_END_REGEX.test(word)) flush();
	}
	flush();
	return segments;
}
