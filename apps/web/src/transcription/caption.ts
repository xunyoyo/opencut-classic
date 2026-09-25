import type { TranscriptionSegment, CaptionChunk } from "@/transcription/types";
import {
	DEFAULT_CHARS_PER_CAPTION,
	DEFAULT_WORDS_PER_CAPTION,
	MIN_CAPTION_DURATION_SECONDS,
} from "@/transcription/caption-defaults";

/**
 * Han, kana, hangul, and the CJK punctuation and fullwidth forms that sit on
 * the same baseline. These scripts are written without word separators, so
 * `split(/\s+/)` hands back a whole Chinese line as a single "word" and the
 * display floor then stretches that one block across everything the speaker
 * says. Fullwidth punctuation is folded in so a comma stays with the caption it
 * belongs to instead of becoming a token of its own.
 */
const CJK_CHAR =
	"\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const CJK_REGEX = new RegExp(`[${CJK_CHAR}]`);

/**
 * A single ordered pass over the text: one CJK character, or one run of
 * non-CJK characters. Runs end at whitespace, so latin words arrive whole and
 * the separators between them are consumed rather than becoming tokens.
 */
const TOKEN_REGEX = new RegExp(`[${CJK_CHAR}]|[^\\s${CJK_CHAR}]+`, "g");

interface TextToken {
	text: string;
	isCjk: boolean;
}

function tokenizeSegmentText({ text }: { text: string }): TextToken[] {
	const matches = text.normalize("NFC").match(TOKEN_REGEX) ?? [];
	return matches.map((match) => ({
		text: match,
		isCjk: CJK_REGEX.test(match),
	}));
}

/**
 * Rebuild the spoken text from its tokens. A space is inserted only between two
 * adjacent latin words: the tokenizer consumed the whitespace that was really
 * there, so re-adding one around CJK or fullwidth punctuation would introduce
 * gaps the speaker never left ("好的 OK" must not become "好的 O K").
 */
function joinGroupText({ group }: { group: TextToken[] }): string {
	return group.reduce((text, token, tokenIndex) => {
		const previousToken = group[tokenIndex - 1];
		const needsSeparator =
			previousToken !== undefined && !previousToken.isCjk && !token.isCjk;
		return needsSeparator ? `${text} ${token.text}` : `${text}${token.text}`;
	}, "");
}

export function buildCaptionChunks({
	segments,
	wordsPerChunk = DEFAULT_WORDS_PER_CAPTION,
	charsPerChunk = DEFAULT_CHARS_PER_CAPTION,
	minDuration = MIN_CAPTION_DURATION_SECONDS,
}: {
	segments: TranscriptionSegment[];
	wordsPerChunk?: number;
	charsPerChunk?: number;
	minDuration?: number;
}): CaptionChunk[] {
	const captions: CaptionChunk[] = [];

	for (const segment of segments) {
		const tokens = tokenizeSegmentText({ text: segment.text });
		if (tokens.length === 0) continue;

		// Nine han characters and three latin words cover a comparable share of
		// the frame, so the tighter budget applies whenever han characters are
		// at least as numerous as latin words.
		const cjkCount = tokens.filter((token) => token.isCjk).length;
		const budget =
			cjkCount >= tokens.length - cjkCount ? charsPerChunk : wordsPerChunk;

		const groups: TextToken[][] = [];
		let currentGroup: TextToken[] = [];
		for (const token of tokens) {
			if (currentGroup.length >= budget) {
				groups.push(currentGroup);
				currentGroup = [];
			}

			currentGroup.push(token);
		}
		if (currentGroup.length > 0) groups.push(currentGroup);

		const segmentDuration = Math.max(0, segment.end - segment.start);
		const secondsPerToken = segmentDuration / tokens.length;

		let consumedTokens = 0;
		for (const group of groups) {
			// Placement is proportional off the segment's own clock. A cursor
			// advanced by each caption's measured duration would instead bank
			// the `minDuration` inflation below and push every later caption
			// progressively late.
			const startTime = segment.start + consumedTokens * secondsPerToken;
			const naturalEndTime = startTime + group.length * secondsPerToken;
			const displayEndTime = Math.max(naturalEndTime, startTime + minDuration);

			captions.push({
				text: joinGroupText({ group }),
				startTime,
				// Clipped at the segment end: spilling into the next segment's
				// dialogue would make the placement layer drop the caption onto
				// an extra track rather than reject the move.
				duration: Math.max(
					0,
					Math.min(displayEndTime, segment.end) - startTime,
				),
			});

			consumedTokens += group.length;
		}
	}

	return captions;
}
