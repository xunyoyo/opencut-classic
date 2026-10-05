import { describe, expect, test } from "bun:test";
import {
	leadingSilenceSeconds,
	placeWindowWords,
	planTranscriptionWindows,
	resolveChunkTimes,
	segmentsFromSegmentChunks,
	segmentsFromWordChunks,
	type WhisperChunk,
	wordTimingsLookUsable,
} from "@/transcription/whisper-chunks";
import { buildCaptionChunks } from "@/transcription/caption";

function expectInOrder({
	items,
}: {
	items: { start: number; end: number }[];
}) {
	items.forEach((item, index) => {
		expect(item.end).toBeGreaterThanOrEqual(item.start);
		if (index > 0) {
			expect(item.start).toBeGreaterThanOrEqual(items[index - 1].start);
			expect(item.start).toBeGreaterThanOrEqual(items[index - 1].end);
		}
	});
}

describe("resolveChunkTimes", () => {
	test("keeps known times as they are", () => {
		const resolved = resolveChunkTimes({
			chunks: [
				{ text: "你好", timestamp: [3.2, 4] },
				{ text: "世界", timestamp: [4.5, 5.1] },
			],
		});
		expect(resolved).toEqual([
			{ text: "你好", start: 3.2, end: 4 },
			{ text: "世界", start: 4.5, end: 5.1 },
		]);
	});

	test("a missing start continues from the previous end, never from 0", () => {
		const resolved = resolveChunkTimes({
			chunks: [
				{ text: "第一句", timestamp: [3, 5] },
				{ text: "第二句", timestamp: [null, 8] },
			],
		});
		expect(resolved[1].start).toBe(5);
		expect(resolved[1].end).toBe(8);
	});

	test("a missing start on the first chunk backs off from its end", () => {
		const resolved = resolveChunkTimes({
			chunks: [{ text: "你好", timestamp: [null, 4] }],
		});
		expect(resolved[0].start).toBeGreaterThan(3);
		expect(resolved[0].start).toBeLessThan(4);
	});

	test("a missing end runs to the next start but not across a long silence", () => {
		const resolved = resolveChunkTimes({
			chunks: [
				{ text: "好", timestamp: [2, null] },
				{ text: "的", timestamp: [2.1, 2.4] },
				{ text: "下个月的房租", timestamp: [2.4, null] },
				{ text: "记得交", timestamp: [30, 31] },
			],
		});
		expect(resolved[0].end).toBe(2.1);
		expect(resolved[2].end).toBeGreaterThan(2.4);
		expect(resolved[2].end).toBeLessThan(5);
	});

	test("the last chunk's missing end stops at the end of the audio", () => {
		const resolved = resolveChunkTimes({
			chunks: [{ text: "我明天就去银行转账", timestamp: [10, null] }],
			audioDuration: 11,
		});
		expect(resolved[0].end).toBe(11);
	});

	test("starts never go backwards and chunks never overlap", () => {
		const resolved = resolveChunkTimes({
			chunks: [
				{ text: "a", timestamp: [5, 6.5] },
				{ text: "b", timestamp: [6, 7] },
				{ text: "c", timestamp: [4, 4.2] },
				{ text: "d", timestamp: [null, null] },
			],
		});
		expectInOrder({ items: resolved });
		expect(resolved[0].end).toBe(6);
		expect(resolved[2].start).toBe(6);
	});

	test("every time missing still yields ordered, non-negative times", () => {
		const resolved = resolveChunkTimes({
			chunks: [
				{ text: "一", timestamp: [null, null] },
				{ text: "二", timestamp: null },
				{ text: "三" },
			],
		});
		expectInOrder({ items: resolved });
		expect(resolved[0].start).toBe(0);
		expect(resolved[2].end).toBeGreaterThan(resolved[2].start);
	});
});

describe("segmentsFromSegmentChunks", () => {
	test("trims text, drops empty chunks and repairs nulls", () => {
		const segments = segmentsFromSegmentChunks({
			chunks: [
				{ text: " Good morning everyone.", timestamp: [3, 5] },
				{ text: " ", timestamp: [5, 5] },
				{ text: " Today we talk.", timestamp: [null, null] },
			],
			audioDuration: 20,
		});
		expect(segments.map((segment) => segment.text)).toEqual([
			"Good morning everyone.",
			"Today we talk.",
		]);
		expect(segments[1].start).toBe(5);
		expect(segments[1].end).toBeGreaterThan(5);
		expect(segments.every((segment) => segment.words === undefined)).toBe(true);
	});
});

describe("leading silence for segment timings", () => {
	const sampleRate = 1000;

	test("finds where sound begins", () => {
		const audio = new Float32Array(5 * sampleRate);
		audio.fill(0.2, 3 * sampleRate);
		expect(leadingSilenceSeconds({ audio, sampleRate })).toBeCloseTo(3, 1);
	});

	test("background noise above the floor means no leading silence", () => {
		const audio = new Float32Array(5 * sampleRate).fill(0.05);
		expect(leadingSilenceSeconds({ audio, sampleRate })).toBe(0);
	});

	test("the first segment moves off Whisper's 0 to where speech starts", () => {
		// whisper-small, segment mode, same clip: speech starts at 3s.
		const segments = segmentsFromSegmentChunks({
			chunks: [
				{ text: "今天天气很好,我们一起去公园散步吧!", timestamp: [0, 6.4] },
				{ text: "下个月的房租,你记得早点交给我!", timestamp: [6.4, 10.5] },
			],
			speechStart: 2.98,
		});
		expect(segments[0].start).toBe(2.98);
		expect(segments[1].start).toBe(6.4);
	});

	test("a speech start past the first segment's end is ignored", () => {
		const segments = segmentsFromSegmentChunks({
			chunks: [{ text: "好的", timestamp: [0, 1] }],
			speechStart: 4,
		});
		expect(segments[0].start).toBe(0);
	});
});

describe("segmentsFromWordChunks", () => {
	const englishWords: WhisperChunk[] = [
		{ text: " Good", timestamp: [3.02, 3.3] },
		{ text: " morning", timestamp: [3.3, 3.62] },
		{ text: " everyone.", timestamp: [3.62, 4.2] },
		{ text: " Today", timestamp: [5.7, 6] },
		{ text: " we", timestamp: [6, 6.12] },
		{ text: " talk", timestamp: [6.12, 6.4] },
		{ text: " about", timestamp: [6.4, 6.7] },
		{ text: " editing", timestamp: [7.9, 8.3] },
	];

	test("splits at sentence ends and long pauses, keeping the words", () => {
		const segments = segmentsFromWordChunks({ chunks: englishWords });
		expect(segments.map((segment) => segment.text)).toEqual([
			"Good morning everyone.",
			"Today we talk about",
			"editing",
		]);
		expect(segments[0]).toMatchObject({ start: 3.02, end: 4.2 });
		expect(segments[0].words).toEqual([
			{ word: "Good", start: 3.02, end: 3.3 },
			{ word: "morning", start: 3.3, end: 3.62 },
			{ word: "everyone.", start: 3.62, end: 4.2 },
		]);
	});

	test("Chinese character words with standalone marks", () => {
		const chunks: WhisperChunk[] = [
			{ text: "好", timestamp: [3.1, 3.3] },
			{ text: "的", timestamp: [3.3, 3.5] },
			{ text: "，", timestamp: [3.5, 3.5] },
			{ text: "没", timestamp: [3.7, 3.9] },
			{ text: "问", timestamp: [3.9, 4.1] },
			{ text: "题", timestamp: [4.1, 4.4] },
			{ text: "。", timestamp: [4.4, 4.4] },
			{ text: "明", timestamp: [5, 5.2] },
			{ text: "天", timestamp: [5.2, null] },
		];
		const segments = segmentsFromWordChunks({ chunks, audioDuration: 6 });
		expect(segments.map((segment) => segment.text)).toEqual([
			"好的，没问题。",
			"明天",
		]);
		expect(segments[0].words?.map((word) => word.word)).toEqual([
			"好",
			"的",
			"没",
			"问",
			"题",
		]);
		expect(segments[1].end).toBeGreaterThan(5.2);
		expect(segments[1].end).toBeLessThanOrEqual(6);
	});

	test("a null word start is not pulled back to the beginning", () => {
		const segments = segmentsFromWordChunks({
			chunks: [
				{ text: "下", timestamp: [null, 3.4] },
				{ text: "个", timestamp: [3.4, 3.6] },
				{ text: "月", timestamp: [null, 3.9] },
			],
		});
		expect(segments[0].start).toBeGreaterThan(3);
		expect(segments[0].words?.[2].start).toBe(3.6);
		expectInOrder({ items: segments[0].words ?? [] });
	});

	test("captions built from local word output start when speech starts", () => {
		const segments = segmentsFromWordChunks({ chunks: englishWords });
		const captions = buildCaptionChunks({ segments });
		expect(captions[0].startTime).toBeCloseTo(3.02, 5);
		expect(captions.some((caption) => caption.startTime < 3)).toBe(false);
	});
});

/**
 * Recorded 2026-10-05 from onnx-community/whisper-small_timestamped (q4,
 * Transformers.js 3.8.1, return_timestamps "word") on a `say -v Tingting` clip
 * with three seconds of silence before the first line. The first word takes
 * the leading silence (0s→3.3s), and the first word after a pause starts
 * early.
 */
const RECORDED_SMALL_ZH: WhisperChunk[] = [
	{ text: "今天", timestamp: [0, 3.3] },
	{ text: "天", timestamp: [3.3, 3.68] },
	{ text: "气", timestamp: [3.68, 3.94] },
	{ text: "很好,", timestamp: [3.94, 4.46] },
	{ text: "我们", timestamp: [4.86, 5.06] },
	{ text: "一起", timestamp: [5.06, 5.44] },
	{ text: "去", timestamp: [5.44, 5.8] },
	{ text: "公", timestamp: [5.8, 5.98] },
	{ text: "园", timestamp: [5.98, 6.26] },
	{ text: "散", timestamp: [6.26, 6.48] },
	{ text: "步", timestamp: [6.48, 6.7] },
	{ text: "吧!", timestamp: [6.7, 6.96] },
	{ text: "下", timestamp: [8.26, 8.9] },
	{ text: "个", timestamp: [8.9, 9.08] },
	{ text: "月", timestamp: [9.08, 9.24] },
	{ text: "的", timestamp: [9.24, 9.4] },
	{ text: "房", timestamp: [9.4, 9.62] },
	{ text: "租,", timestamp: [9.62, 9.86] },
];

describe("planTranscriptionWindows", () => {
	const sampleRate = 100;

	test("short audio is one window", () => {
		const audio = new Float32Array(25 * sampleRate).fill(0.5);
		expect(planTranscriptionWindows({ audio, sampleRate })).toEqual([
			{ start: 0, end: audio.length },
		]);
	});

	test("long audio is cut in the quiet stretch, windows cover it all", () => {
		const audio = new Float32Array(70 * sampleRate).fill(0.5);
		// Pauses at 24.5s-25.5s and 52s-53s.
		audio.fill(0, 24.5 * sampleRate, 25.5 * sampleRate);
		audio.fill(0, 52 * sampleRate, 53 * sampleRate);
		const windows = planTranscriptionWindows({ audio, sampleRate });
		expect(windows.length).toBe(3);
		expect(windows[0].start).toBe(0);
		expect(windows[windows.length - 1].end).toBe(audio.length);
		windows.forEach((window, index) => {
			expect(window.end - window.start).toBeLessThanOrEqual(30 * sampleRate);
			if (index > 0) expect(window.start).toBe(windows[index - 1].end);
		});
		expect(windows[0].end / sampleRate).toBeGreaterThanOrEqual(24.5);
		expect(windows[0].end / sampleRate).toBeLessThanOrEqual(25.5);
		expect(windows[1].end / sampleRate).toBeGreaterThanOrEqual(52);
		expect(windows[1].end / sampleRate).toBeLessThanOrEqual(53);
	});

	test("empty audio still yields one window", () => {
		expect(
			planTranscriptionWindows({ audio: new Float32Array(0), sampleRate }),
		).toEqual([{ start: 0, end: 0 }]);
	});
});

describe("placeWindowWords", () => {
	test("the first word gives up the leading silence", () => {
		const placed = placeWindowWords({
			chunks: RECORDED_SMALL_ZH,
			offsetSeconds: 0,
		});
		expect(placed[0].timestamp?.[0]).toBeCloseTo(2.8, 5);
		expect(placed[0].timestamp?.[1]).toBe(3.3);
		expect(placed.slice(1)).toEqual(RECORDED_SMALL_ZH.slice(1));
	});

	test("a word after a clause mark gives up the pause before it", () => {
		const placed = placeWindowWords({
			chunks: [
				{ text: " everyone.", timestamp: [3.44, 3.94] },
				{ text: " Today", timestamp: [4.96, 6.1] },
			],
			offsetSeconds: 0,
		});
		expect(placed[1].timestamp?.[0]).toBeCloseTo(5.75, 5);
		expect(placed[1].timestamp?.[1]).toBe(6.1);
	});

	test("a word that ends a clause gives up the pause after it", () => {
		const placed = placeWindowWords({
			chunks: [
				{ text: "步", timestamp: [6.6, 6.82] },
				{ text: "吧", timestamp: [6.82, 8.42] },
				{ text: "下", timestamp: [8.42, 8.6] },
			],
			offsetSeconds: 0,
		});
		expect(placed[1].timestamp?.[0]).toBe(6.82);
		expect(placed[1].timestamp?.[1]).toBeCloseTo(7.07, 5);
	});

	test("moves words onto the clip clock and keeps unknown times unknown", () => {
		const placed = placeWindowWords({
			chunks: [
				{ text: "好", timestamp: [0.2, 0.4] },
				{ text: "的", timestamp: [0.4, null] },
			],
			offsetSeconds: 29.5,
		});
		expect(placed[0].timestamp?.[0]).toBeCloseTo(29.7, 5);
		expect(placed[1].timestamp?.[1]).toBeNull();
	});
});

describe("wordTimingsLookUsable", () => {
	test("accepts real word timings", () => {
		expect(
			wordTimingsLookUsable({ chunks: RECORDED_SMALL_ZH, audioDuration: 19.3 }),
		).toBe(true);
	});

	test("rejects every word collapsed onto one instant", () => {
		// whisper-medium on English: every word at 29.76s in a 14.9s clip.
		const chunks = ["Good", "morning", "everyone."].map((text) => ({
			text: ` ${text}`,
			timestamp: [29.76, 29.76],
		}));
		expect(wordTimingsLookUsable({ chunks, audioDuration: 40 })).toBe(false);
		expect(wordTimingsLookUsable({ chunks, audioDuration: 14.9 })).toBe(false);
	});

	test("rejects output with no words", () => {
		expect(wordTimingsLookUsable({ chunks: [], audioDuration: 10 })).toBe(
			false,
		);
	});
});

describe("local word output end to end", () => {
	test("Chinese captions start with the speech, not at 0", () => {
		const segments = segmentsFromWordChunks({
			chunks: placeWindowWords({ chunks: RECORDED_SMALL_ZH, offsetSeconds: 0 }),
			audioDuration: 19.3,
		});
		expect(segments.map((segment) => segment.text)).toEqual([
			"今天天气很好,我们一起去公园散步吧!",
			"下个月的房租,",
		]);
		const captions = buildCaptionChunks({ segments });
		expect(captions[0].startTime).toBeGreaterThan(2.5);
		const second = captions.find((caption) => caption.text.startsWith("下"));
		expect(second?.startTime).toBeCloseTo(8.26, 5);
		for (let index = 1; index < captions.length; index++) {
			expect(captions[index].startTime).toBeGreaterThanOrEqual(
				captions[index - 1].startTime + captions[index - 1].duration - 1e-9,
			);
		}
	});
});
