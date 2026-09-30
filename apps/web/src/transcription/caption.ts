import type {
	CaptionChunk,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";
import {
	CAPTION_CLAUSE_PAUSE_SECONDS,
	CAPTION_MAX_JOIN_GAP_SECONDS,
	CAPTION_MIN_VISIBLE_SECONDS,
	DEFAULT_CHARS_PER_CAPTION,
	DEFAULT_WORDS_PER_CAPTION,
	MIN_CAPTION_CHARS,
	MIN_CAPTION_DURATION_SECONDS,
} from "@/transcription/caption-defaults";

/**
 * Scripts written without word separators. Each character becomes its own
 * unit: `split(/\s+/)` would hand back a whole Chinese line as one "word".
 * Hangul is left out on purpose — Korean separates words with spaces, so it
 * tokenizes like latin text. ー (prolonged sound mark) and 々 (iteration
 * mark) belong to no script of their own but are written inside Japanese and
 * Chinese words.
 */
const CJK_SCRIPT = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\u30fc\\u3005";

/**
 * Punctuation that separates words even with no space around it: CJK and
 * fullwidth marks, curly double quotes, the ellipsis, the em dash and middle
 * dots. Without it 「Python、Java、Go」 is one run that can never be split.
 * Curly single quotes are left out — ’ is also the apostrophe in "it’s".
 */
const SEPARATOR_PUNCT =
	"\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65\\u201c\\u201d\\u2026\\u2014\\u00b7\\u30fb";

/**
 * One CJK character, one separating mark, or one run of anything else up to
 * whitespace. Runs are kept whole so "7.5", "10:30", "1,280", "U.S." and
 * "well-known" survive as written; only the punctuation at either end is
 * split off afterwards.
 */
const UNIT_REGEX = new RegExp(
	`[${CJK_SCRIPT}]|[${SEPARATOR_PUNCT}]|[^\\s${CJK_SCRIPT}${SEPARATOR_PUNCT}]+`,
	"gu",
);
const CJK_REGEX = new RegExp(`[${CJK_SCRIPT}]`, "u");
const LEADING_PUNCT_REGEX = new RegExp("^[^\\p{L}\\p{N}]+", "u");
const TRAILING_PUNCT_REGEX = new RegExp("[^\\p{L}\\p{N}]+$", "u");
/**
 * Marks that open what follows rather than close what precedes. Straight
 * quotes are left out: they open or close depending on the spacing around
 * them, which `attachLeading` already accounts for.
 */
const OPENING_PUNCT_REGEX = new RegExp("[\\p{Ps}\\p{Pi}\\p{Sc}#@¿¡]", "u");
const CONTENT_REGEX = new RegExp("[\\p{L}\\p{N}]", "gu");
const ENDS_WITH_DIGIT_REGEX = new RegExp("\\p{N}$", "u");
const HAS_CONTENT_REGEX = new RegExp("[\\p{L}\\p{N}]", "u");
const SENTENCE_END_REGEX = /[。！？!?…]/;
/** Words whose full stop is part of the word: "U.S.", "e.g.", "Mr.". */
const ABBREVIATION_REGEX = new RegExp(
	"^(?:\\p{L}\\.)+\\p{L}$|^(?:mr|mrs|ms|dr|prof|jr|sr|vs)$",
	"iu",
);
const CLAUSE_END_REGEX = /[，,、；;：:—]/;
/** Stripped from the end of a Chinese caption, as subtitles conventionally are. */
const TRAILING_CJK_PUNCT_REGEX = /[，,、；;：:。.]+$/;
/**
 * Fullwidth stops only occur in CJK text, so they are dropped even when the
 * caption happens to end on a number or latin word ("涨了12.5%，").
 */
const TRAILING_FULLWIDTH_PUNCT_REGEX = /[，、；：。]+$/;
/** ASCII marks the recogniser emits inside Chinese text, shown in fullwidth. */
const FULLWIDTH_PUNCT: Record<string, string> = {
	",": "，",
	"?": "？",
	"!": "！",
	":": "：",
	";": "；",
};

interface CaptionUnit {
	/** Letters/digits, or a lone punctuation mark with nothing to attach to. */
	text: string;
	/** Punctuation that preceded this unit within its segment (opening quotes). */
	lead: string;
	/** Punctuation that followed this unit. */
	trail: string;
	isCjk: boolean;
	/** Whether whitespace preceded this unit in the source text. */
	spaceBefore: boolean;
	start: number;
	end: number;
	segmentIndex: number;
	segmentEnd: number;
	/** Whether a lexical word begins at this unit, i.e. a split before it is allowed. */
	wordStart: boolean;
}

interface RawUnit {
	text: string;
	lead: string;
	trail: string;
	isCjk: boolean;
	spaceBefore: boolean;
}

function tokenize({ text }: { text: string }): RawUnit[] {
	const normalized = text.normalize("NFC");
	const units: RawUnit[] = [];
	// Marks waiting for the next unit. Once anything is pending, later marks
	// queue behind it rather than jumping back onto the previous unit, so the
	// written order is kept.
	let pendingLead = "";

	const attachToPrevious = (marks: string) => {
		const previous = units[units.length - 1];
		if (previous && !pendingLead) previous.trail += marks;
		else pendingLead += marks;
	};

	/**
	 * Marks written against the following unit either close the previous one
	 * (「好的,OK」) or open the next ("(OK", "$5"). After whitespace they can
	 * only open; directly after a unit only the opening marks do.
	 */
	const attachLeading = ({
		marks,
		afterSpace,
	}: {
		marks: string;
		afterSpace: boolean;
	}) => {
		if (afterSpace || units.length === 0 || pendingLead) {
			pendingLead += marks;
			return;
		}
		let index = 0;
		while (index < marks.length && !OPENING_PUNCT_REGEX.test(marks[index])) {
			index += 1;
		}
		units[units.length - 1].trail += marks.slice(0, index);
		pendingLead += marks.slice(index);
	};

	for (const match of normalized.matchAll(UNIT_REGEX)) {
		const token = match[0];
		const offset = match.index ?? 0;
		const tokenEnd = offset + token.length;
		const afterSpace = offset === 0 || /\s/.test(normalized[offset - 1]);
		const beforeSpace =
			tokenEnd >= normalized.length || /\s/.test(normalized[tokenEnd]);

		if (CJK_REGEX.test(token)) {
			units.push({
				text: token,
				lead: pendingLead,
				trail: "",
				isCjk: true,
				spaceBefore: afterSpace,
			});
			pendingLead = "";
			continue;
		}

		if (!HAS_CONTENT_REGEX.test(token)) {
			const previous = units[units.length - 1];
			if (afterSpace && beforeSpace) {
				// Standing on its own ("Tom & Jerry", "5 €"): stays with the word
				// before it, spacing included.
				if (previous && !pendingLead) previous.trail += ` ${token}`;
				else pendingLead += `${token} `;
			} else if (beforeSpace) {
				attachToPrevious(token);
			} else {
				attachLeading({ marks: token, afterSpace });
			}
			continue;
		}

		const lead = token.match(LEADING_PUNCT_REGEX)?.[0] ?? "";
		const trail = token.match(TRAILING_PUNCT_REGEX)?.[0] ?? "";
		attachLeading({ marks: lead, afterSpace });
		units.push({
			text: token.slice(lead.length, token.length - trail.length),
			lead: pendingLead,
			trail,
			isCjk: false,
			spaceBefore: afterSpace,
		});
		pendingLead = "";
	}

	// An opening mark at the very end of a segment ("他说：“") has nothing left
	// to open; it is kept on the last unit rather than dropped.
	const last = units[units.length - 1];
	if (last && pendingLead) last.trail += pendingLead;
	return units;
}

/**
 * Whether the unit ends a sentence. A full stop counts unless it is part of
 * an ellipsis or an abbreviation; a decimal ("3.99.") still ends one.
 */
function endsSentence({ unit }: { unit: RawUnit }): boolean {
	if (SENTENCE_END_REGEX.test(unit.trail)) return true;
	return (
		unit.trail.endsWith(".") &&
		!unit.trail.endsWith("..") &&
		!ABBREVIATION_REGEX.test(unit.text)
	);
}

function contentChars({ text }: { text: string }): string[] {
	return text.normalize("NFC").toLowerCase().match(CONTENT_REGEX) ?? [];
}

/**
 * Per-character timestamps from the recogniser's word timings. A word's span is
 * shared evenly among its own characters only — the error is bounded by one
 * word, instead of by a whole segment as it was when the segment was split
 * evenly across every character.
 */
function timeWordCharacters({
	words,
}: {
	words: TranscriptionWord[];
}): { char: string; start: number; end: number }[] {
	const timed: { char: string; start: number; end: number }[] = [];
	for (const word of words) {
		const chars = contentChars({ text: word.word });
		const end = Math.max(word.start, word.end);
		const step = chars.length > 0 ? (end - word.start) / chars.length : 0;
		chars.forEach((char, index) => {
			timed.push({
				char,
				start: word.start + index * step,
				end: word.start + (index + 1) * step,
			});
		});
	}
	return timed;
}

/**
 * Places the segment's units on the clock. With word timings the units get the
 * time the speaker actually said them; without (the in-browser engine returns
 * none) the segment is split evenly, which is all that is known.
 */
function timeUnits({
	segment,
	segmentIndex,
}: {
	segment: TranscriptionSegment;
	segmentIndex: number;
}): Omit<CaptionUnit, "wordStart">[] {
	const segmentEnd = Math.max(segment.start, segment.end);
	const place = (raw: RawUnit, start: number, end: number) => ({
		...raw,
		start,
		end,
		segmentIndex,
		segmentEnd,
	});

	const words = segment.words?.filter((word) => word.word.trim()) ?? [];
	if (words.length > 0) {
		const timedChars = timeWordCharacters({ words });
		// The segment text carries the punctuation; the words carry the timing.
		// When the two disagree, rebuild from the words so timing wins.
		let units = tokenize({ text: segment.text });
		const unitChars = units.flatMap((unit) => contentChars({ text: unit.text }));
		const aligned =
			unitChars.length === timedChars.length &&
			unitChars.every((char, index) => char === timedChars[index].char);
		if (!aligned) {
			units = tokenize({ text: words.map((word) => word.word).join(" ") });
		}

		let cursor = 0;
		const placed = units.map((unit) => {
			const length = contentChars({ text: unit.text }).length;
			const first = timedChars[cursor];
			const last = timedChars[cursor + Math.max(0, length - 1)];
			cursor += length;
			return place(unit, first?.start ?? segment.start, last?.end ?? segmentEnd);
		});
		if (placed.length > 0 && cursor === timedChars.length) return placed;
	}

	const units = tokenize({ text: segment.text });
	const secondsPerUnit =
		units.length > 0 ? (segmentEnd - segment.start) / units.length : 0;
	return units.map((unit, index) =>
		place(
			unit,
			segment.start + index * secondsPerUnit,
			segment.start + (index + 1) * secondsPerUnit,
		),
	);
}

let segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
	if (segmenter === undefined) {
		segmenter =
			typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
				? new Intl.Segmenter("zh", { granularity: "word" })
				: null;
	}
	return segmenter;
}

/**
 * Marks where lexical words begin, so a caption is never cut through the
 * middle of one ("下/月"). The recogniser's own word list is no help here: for
 * Chinese it reports most characters as separate words. Without
 * `Intl.Segmenter` every unit is a candidate, which is what the old splitter
 * assumed anyway.
 */
function markWordStarts({
	units,
}: {
	units: Omit<CaptionUnit, "wordStart">[];
}): CaptionUnit[] {
	const wordStarts = new Set<number>();
	const instance = getSegmenter();
	if (instance) {
		// Latin units get a separating space so adjacent words stay apart; CJK
		// characters are concatenated so the segmenter sees real Chinese text.
		let text = "";
		const offsets: number[] = [];
		units.forEach((unit, index) => {
			const previous = units[index - 1];
			if (previous && !previous.isCjk && !unit.isCjk) text += " ";
			offsets.push(text.length);
			text += unit.text;
		});
		const boundaries = new Set<number>();
		for (const piece of instance.segment(text)) boundaries.add(piece.index);
		offsets.forEach((offset, index) => {
			if (boundaries.has(offset)) wordStarts.add(index);
		});
	}

	return units.map((unit, index) => {
		const previous = units[index - 1];
		// A number written straight against the character after it is one
		// word with its measure: 「7.5元」, 「2024年」, 「3个」.
		const measuredNumber =
			previous !== undefined &&
			!previous.isCjk &&
			unit.isCjk &&
			!unit.spaceBefore &&
			!previous.trail &&
			ENDS_WITH_DIGIT_REGEX.test(previous.text);
		return {
			...unit,
			wordStart:
				!measuredNumber &&
				(!instance ||
					index === 0 ||
					!unit.isCjk ||
					!previous.isCjk ||
					wordStarts.has(index)),
		};
	});
}

interface Boundary {
	/** Cost of ending a caption here. */
	split: number;
	/** Cost of a caption running through here. */
	internal: number;
}

const FORCED_BOUNDARY: Boundary = { split: 0, internal: Number.POSITIVE_INFINITY };

/** What sits between `previous` and `next`, from strongest to weakest. */
function classifyBoundary({
	previous,
	next,
}: {
	previous: CaptionUnit;
	next: CaptionUnit;
}): Boundary {
	const gap = next.start - previous.end;
	if (gap > CAPTION_MAX_JOIN_GAP_SECONDS) return FORCED_BOUNDARY;
	if (endsSentence({ unit: previous })) return { split: 0, internal: 4 };
	if (
		CLAUSE_END_REGEX.test(previous.trail) ||
		previous.trail.includes("..") ||
		gap >= CAPTION_CLAUSE_PAUSE_SECONDS
	) {
		return { split: 0.5, internal: 1.5 };
	}
	if (next.segmentIndex !== previous.segmentIndex) return { split: 1, internal: 1 };
	if (next.wordStart) return { split: 3, internal: 0 };
	// Prohibitive rather than impossible: a run the dictionary reads as one
	// word longer than a caption must still be broken somewhere.
	return { split: 50, internal: 0 };
}

/**
 * Chooses where captions break with a shortest-path pass over the units,
 * rather than filling each caption greedily. Greedy filling is what produced
 * the one-character captions: it cannot see that the character left over at
 * the end would be better off with its neighbour. Here every candidate break
 * is priced — punctuation and pauses are cheap, bare word boundaries dear,
 * the middle of a word prohibitive — and captions are priced by how far they
 * stray from the target width, with fragments shorter than
 * `MIN_CAPTION_CHARS` priced highest of all.
 */
function chooseBreaks({
	units,
	weightOf,
	budget,
}: {
	units: CaptionUnit[];
	weightOf: (unit: CaptionUnit) => number;
	budget: number;
}): number[] {
	const maxWeight = budget + Math.ceil(budget / 3);
	const boundaries = units.map((unit, index) =>
		index === 0
			? FORCED_BOUNDARY
			: classifyBoundary({ previous: units[index - 1], next: unit }),
	);

	const best = new Array<number>(units.length + 1).fill(Number.POSITIVE_INFINITY);
	const from = new Array<number>(units.length + 1).fill(0);
	best[0] = 0;

	for (let start = 0; start < units.length; start++) {
		if (!Number.isFinite(best[start])) continue;
		let weight = 0;
		let internal = 0;
		for (let end = start + 1; end <= units.length; end++) {
			if (end - 1 > start) internal += boundaries[end - 1].internal;
			if (!Number.isFinite(internal)) break;
			weight += weightOf(units[end - 1]);
			// A single unit wider than the maximum (a very long latin word) still
			// has to go somewhere.
			if (weight > maxWeight && end - 1 > start) break;

			const splitCost = end === units.length ? 0 : boundaries[end].split;

			const shortfall = Math.max(0, budget - weight);
			const overflow = Math.max(0, weight - budget);
			const cost =
				best[start] +
				splitCost +
				internal +
				overflow * 3 +
				shortfall * shortfall * 0.05 +
				(weight < MIN_CAPTION_CHARS ? 6 : 0);
			if (cost < best[end]) {
				best[end] = cost;
				from[end] = start;
			}
		}
	}

	const breaks: number[] = [];
	for (let end = units.length; end > 0; end = from[end]) breaks.push(end);
	return breaks.reverse();
}

function joinUnits({ units }: { units: CaptionUnit[] }): string {
	const text = units.reduce((joined, unit, index) => {
		const previous = units[index - 1];
		// Only where the source had a space: 「Python、Java」 must not become
		// 「Python、 Java」.
		const separator =
			previous !== undefined &&
			!previous.isCjk &&
			!unit.isCjk &&
			unit.spaceBefore
				? " "
				: "";
		const trail = unit.isCjk
			? unit.trail.replace(/[,?!:;]/g, (mark) => FULLWIDTH_PUNCT[mark] ?? mark)
			: unit.trail;
		return `${joined}${separator}${unit.lead}${unit.text}${trail}`;
	}, "");
	const last = units[units.length - 1];
	// An ellipsis is kept: it says the line trails off, not that it ended.
	if (!last || last.trail.includes("..")) return text;
	return text.replace(
		last.isCjk ? TRAILING_CJK_PUNCT_REGEX : TRAILING_FULLWIDTH_PUNCT_REGEX,
		"",
	);
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
	const units = markWordStarts({
		units: segments.flatMap((segment, segmentIndex) =>
			timeUnits({ segment, segmentIndex }),
		),
	});
	if (units.length === 0) return [];

	// Nine han characters and three latin words cover a comparable share of the
	// frame, so a latin word weighs as much as three characters and one budget
	// serves both scripts, mixed lines included.
	const latinWeight = charsPerChunk / Math.max(1, wordsPerChunk);
	const breaks = chooseBreaks({
		units,
		weightOf: (unit) => (unit.isCjk ? 1 : latinWeight),
		budget: charsPerChunk,
	});

	const groups: CaptionUnit[][] = [];
	let start = 0;
	for (const end of breaks) {
		groups.push(units.slice(start, end));
		start = end;
	}

	// Word timings can collapse onto one instant (the recogniser does this at
	// the tail of a hallucinated run), and a caption with no duration is never
	// visible. Captions sharing an instant are spread over the time up to the
	// next caption that starts later — never past it, so a collapsed run can
	// not delay the real dialogue that follows.
	const startTimes = groups.map((group) => group[0].start);
	for (let index = 1; index < startTimes.length; index++) {
		startTimes[index] = Math.max(startTimes[index], startTimes[index - 1]);
	}
	for (let runStart = 0; runStart < groups.length; ) {
		let runEnd = runStart + 1;
		while (
			runEnd < groups.length &&
			startTimes[runEnd] === startTimes[runStart]
		) {
			runEnd += 1;
		}
		const count = runEnd - runStart;
		if (count > 1) {
			const from = startTimes[runStart];
			const lastGroup = groups[runEnd - 1];
			const until =
				runEnd < groups.length
					? startTimes[runEnd]
					: Math.max(
							from + count * CAPTION_MIN_VISIBLE_SECONDS,
							lastGroup[lastGroup.length - 1].segmentEnd,
						);
			const step = (until - from) / count;
			for (let offset = 1; offset < count; offset++) {
				startTimes[runStart + offset] = from + offset * step;
			}
		}
		runStart = runEnd;
	}

	return groups.map((group, index) => {
		const last = group[group.length - 1];
		const startTime = startTimes[index];
		const displayEnd = Math.max(last.end, startTime + minDuration);
		// The display floor never pushes into the next caption or past the
		// dialogue it belongs to: overlapping captions would be dropped onto an
		// extra track by the placement layer. A word the recogniser timed past
		// its own segment's end still counts as dialogue.
		const nextStart = startTimes[index + 1] ?? Number.POSITIVE_INFINITY;
		const dialogueEnd = Math.max(last.segmentEnd, last.end);
		const endTime = Math.max(
			Math.min(displayEnd, dialogueEnd, nextStart),
			Math.min(startTime + CAPTION_MIN_VISIBLE_SECONDS, nextStart),
		);
		return {
			text: joinUnits({ units: group }),
			startTime,
			duration: endTime - startTime,
		};
	});
}
