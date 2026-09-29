import { describe, expect, test } from "bun:test";
import { buildCaptionChunks } from "@/transcription/caption";
import type {
	CaptionChunk,
	TranscriptionSegment,
	TranscriptionWord,
} from "@/transcription/types";

const EPSILON = 1e-9;

function endOf({ chunk }: { chunk: CaptionChunk }): number {
	return chunk.startTime + chunk.duration;
}

/**
 * Recorded from ephone whisper-1 on 2026-09-29 (timestamp_granularities
 * word+segment) for a clip with three seconds of silence before the first
 * line. The recogniser reports most Chinese characters as separate words, and
 * the pauses between clauses are uneven — exactly what spreading a segment
 * evenly across its characters got wrong.
 */
const RECORDED_WORDS: TranscriptionWord[] = [
	{ word: "小", start: 2.88, end: 3.32 },
	{ word: "白", start: 3.32, end: 3.46 },
	{ word: "不是", start: 3.96, end: 4.16 },
	{ word: "我", start: 4.16, end: 4.48 },
	{ word: "趕", start: 4.48, end: 4.58 },
	{ word: "你", start: 4.58, end: 4.9 },
	{ word: "走", start: 4.9, end: 5.08 },
	{ word: "下", start: 5.44, end: 5.62 },
	{ word: "月", start: 5.62, end: 5.84 },
	{ word: "房", start: 5.84, end: 6.12 },
	{ word: "租", start: 6.12, end: 6.28 },
	{ word: "可", start: 6.82, end: 6.9 },
	{ word: "真的", start: 6.9, end: 7.2 },
	{ word: "給", start: 7.2, end: 7.4 },
	{ word: "我", start: 7.4, end: 7.66 },
	{ word: "了", start: 7.66, end: 8.06 },
];

const RECORDED_SEGMENTS: TranscriptionSegment[] = [
	{
		text: "小白,不是我趕你走,下月房租,可真的給我了?",
		start: 2.88,
		end: 8.06,
		words: RECORDED_WORDS,
	},
	{
		text: "就晚兩天。",
		start: 9.52,
		end: 10.4,
		words: [
			{ word: "就", start: 9.52, end: 9.66 },
			{ word: "晚", start: 9.66, end: 9.88 },
			{ word: "兩", start: 9.88, end: 10.18 },
			{ word: "天。", start: 10.18, end: 10.4 },
		],
	},
];

describe("buildCaptionChunks with word timings", () => {
	test("every caption starts when its first word is spoken", () => {
		const chunks = buildCaptionChunks({ segments: RECORDED_SEGMENTS });

		expect(chunks.map((chunk) => chunk.text)).toEqual([
			"小白，不是我趕你走",
			"下月房租",
			"可真的給我了？",
			"就晚兩天",
		]);
		// Spread evenly, 「下」 would have landed at 2.88 + 8 × (5.18 / 18) ≈ 5.18s
		// and 「可」 at ≈ 6.33s; the recogniser heard them at 5.44s and 6.82s.
		expect(chunks.map((chunk) => chunk.startTime)).toEqual([
			2.88, 5.44, 6.82, 9.52,
		]);
	});

	test("the gap before a line is kept rather than filled with text", () => {
		// The customer's report: dialogue begins at 3s, captions began at 0s.
		const chunks = buildCaptionChunks({
			segments: [
				{
					text: "你好世界",
					start: 0,
					end: 4,
					words: [
						{ word: "你好", start: 3, end: 3.5 },
						{ word: "世界", start: 3.5, end: 4 },
					],
				},
			],
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0].startTime).toBe(3);
	});

	test("a word split across characters keeps timing inside its own span", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{
					text: "今天天气真不错，我们出去走走吧",
					start: 0,
					end: 10,
					words: [
						{ word: "今天", start: 1, end: 1.4 },
						{ word: "天气", start: 1.4, end: 1.8 },
						{ word: "真", start: 1.8, end: 2 },
						{ word: "不错", start: 2, end: 2.4 },
						{ word: "我们", start: 6, end: 6.4 },
						{ word: "出去", start: 6.4, end: 6.8 },
						{ word: "走走", start: 6.8, end: 7.2 },
						{ word: "吧", start: 7.2, end: 7.4 },
					],
				},
			],
		});

		expect(chunks.map((chunk) => chunk.text)).toEqual([
			"今天天气真不错",
			"我们出去走走吧",
		]);
		expect(chunks[1].startTime).toBe(6);
	});

	test("falls back to the recogniser's words when they disagree with the text", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{
					text: "完全不同的文本",
					start: 0,
					end: 3,
					words: [
						{ word: "你好", start: 1, end: 1.5 },
						{ word: "朋友", start: 2, end: 2.5 },
					],
				},
			],
		});

		expect(chunks.map((chunk) => chunk.text).join("")).toBe("你好朋友");
		expect(chunks[0].startTime).toBe(1);
	});
});

describe("buildCaptionChunks splitting", () => {
	test("a lone particle is folded into its neighbour", () => {
		// Whisper often cuts a drawn-out 「了」 into a segment of its own.
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "下月房租可真得给我", start: 0, end: 2.7 },
				{ text: "了", start: 2.8, end: 3.2 },
			],
		});

		expect(chunks.map((chunk) => chunk.text)).toEqual(["下月房租可真得给我了"]);
	});

	test("does not leave a one-character caption at the end of a long line", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "今天天气不错我们出去走走吧明天一起去", start: 0, end: 6 },
			],
		});

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.length).toBeGreaterThanOrEqual(3);
			expect(chunk.text.length).toBeLessThanOrEqual(12);
		}
		expect(chunks.map((chunk) => chunk.text).join("")).toBe(
			"今天天气不错我们出去走走吧明天一起去",
		);
	});

	test("never splits inside a word", () => {
		// Word boundaries come from Intl.Segmenter's dictionary. It is not
		// infallible — it reads 「赶你走下月」 as 走下/月 — which is why commas and
		// pauses from the recogniser outrank it (see the recorded clip above).
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "今天天气不错我们出去走走吧明天一起去", start: 0, end: 6 },
			],
		});

		const words = ["今天", "天气", "不错", "我们", "出去", "走走", "明天"];
		for (const [index, chunk] of chunks.entries()) {
			const next = chunks[index + 1];
			if (!next) continue;
			expect(words).not.toContain(`${chunk.text.slice(-1)}${next.text[0]}`);
		}
	});

	test("prefers punctuation over the character budget", () => {
		const chunks = buildCaptionChunks({
			segments: [{ text: "你好，世界。今天不错！", start: 0, end: 3 }],
		});

		expect(chunks.map((chunk) => chunk.text)).toEqual(["你好，世界", "今天不错！"]);
	});

	test("does not join text across a long silence", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "好", start: 0, end: 0.5 },
				{ text: "我们走吧", start: 3, end: 4 },
			],
		});

		expect(chunks.map((chunk) => chunk.text)).toEqual(["好", "我们走吧"]);
		expect(chunks[1].startTime).toBe(3);
	});

	test("does not insert spaces around latin words embedded in CJK text", () => {
		const chunks = buildCaptionChunks({
			segments: [{ text: "好的OK我们走吧", start: 0, end: 2 }],
		});

		expect(chunks.map((chunk) => chunk.text).join("")).toBe("好的OK我们走吧");
	});

	test("keeps latin captions word-aligned and space-separated", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "hello there my friend how are you", start: 0, end: 3 },
			],
		});

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.text.split(" ").length).toBeLessThanOrEqual(4);
		}
		expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(
			"hello there my friend how are you",
		);
	});

	test("skips blank segments and tolerates zero-duration ones", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "   ", start: 0, end: 1 },
				{ text: "", start: 1, end: 2 },
				{ text: "甲乙丙", start: 5, end: 5 },
			],
		});

		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe("甲乙丙");
		expect(chunks[0].duration).toBe(0);
		expect(Number.isFinite(chunks[0].startTime)).toBe(true);
	});
});

describe("buildCaptionChunks timing invariants", () => {
	test("drift does not accumulate across a long transcription", () => {
		// 300 segments of fast speech, every caption under the display floor. An
		// earlier implementation banked the floor on a shared cursor and ended
		// 360s late at the ten-minute mark.
		const segments: TranscriptionSegment[] = Array.from(
			{ length: 300 },
			(_, index) => ({
				text: Array.from({ length: 12 }, (__, token) => `w${token}`).join(" "),
				start: index * 2,
				end: index * 2 + 2,
			}),
		);

		const chunks = buildCaptionChunks({ segments });

		expect(endOf({ chunk: chunks[chunks.length - 1] })).toBeCloseTo(600, 6);
		// Every segment's first caption still starts on the speaker's clock.
		for (const segment of segments) {
			expect(
				chunks.some(
					(chunk) => Math.abs(chunk.startTime - segment.start) < EPSILON,
				),
			).toBe(true);
		}
	});

	test("the first caption starts exactly when the first segment starts", () => {
		const chunks = buildCaptionChunks({
			segments: [{ text: "hello there my friend", start: 4.25, end: 9 }],
		});

		expect(chunks[0].startTime).toBeCloseTo(4.25, 9);
	});

	test("captions never overlap and never outlive the last dialogue they show", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "alpha beta gamma delta epsilon", start: 0, end: 3 },
			{ text: "zeta eta theta", start: 3, end: 5 },
			{ text: "iota kappa", start: 5, end: 6 },
			...RECORDED_SEGMENTS.map((segment) => ({
				...segment,
				start: segment.start + 10,
				end: segment.end + 10,
				words: segment.words?.map((word) => ({
					...word,
					start: word.start + 10,
					end: word.end + 10,
				})),
			})),
		];

		const chunks = buildCaptionChunks({ segments });
		for (const [index, chunk] of chunks.entries()) {
			const next = chunks[index + 1];
			if (next) {
				expect(endOf({ chunk })).toBeLessThanOrEqual(next.startTime + EPSILON);
			}
			expect(endOf({ chunk })).toBeLessThanOrEqual(20.4 + EPSILON);
		}
	});

	test("the display floor widens a caption without moving the next one", () => {
		const chunks = buildCaptionChunks({
			segments: [
				{
					text: "你好世界",
					start: 0,
					end: 2,
					words: [
						{ word: "你好", start: 0, end: 0.2 },
						{ word: "世界", start: 0.2, end: 0.4 },
					],
				},
				{
					text: "再见朋友",
					start: 2,
					end: 3,
					words: [
						{ word: "再见", start: 2, end: 2.5 },
						{ word: "朋友", start: 2.5, end: 3 },
					],
				},
			],
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[0].duration).toBeCloseTo(0.8, 9);
		expect(chunks[1].startTime).toBe(2);
	});
});
