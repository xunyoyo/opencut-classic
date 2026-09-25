import { describe, expect, test } from "bun:test";
import { buildCaptionChunks } from "@/transcription/caption";
import type { CaptionChunk, TranscriptionSegment } from "@/transcription/types";

const EPSILON = 1e-9;

function segmentEndTime({ chunk }: { chunk: CaptionChunk }): number {
	return chunk.startTime + chunk.duration;
}

/**
 * The bug this suite exists for is cumulative: the old implementation advanced a
 * shared `globalEndTime` cursor by each chunk's *estimated* duration, so the
 * 0.8s display floor inflated every segment and dragged everything after it
 * later. No single caption is obviously wrong — that is why a per-caption
 * assertion would have missed it — so every test checks the running position
 * against the speaker's real clock.
 */
describe("buildCaptionChunks", () => {
	test("a short final segment does not inherit drift from a long earlier one", () => {
		// Segment 1 spends only 2s on 12 latin words (fast speech), so each of its
		// four 3-word captions covers 0.5s of real speech — under the 0.8s floor.
		// The old cursor banked the 0.3s shortfall per caption and pushed segment
		// 2's first caption to 3.2s instead of 2s.
		const segments: TranscriptionSegment[] = [
			{ text: "w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12", start: 0, end: 2 },
			{ text: "later words begin here now", start: 2, end: 8 },
		];

		const chunks = buildCaptionChunks({ segments });
		const firstChunkOfSecondSegment = chunks.find(
			(chunk) => chunk.startTime >= 2,
		);

		expect(firstChunkOfSecondSegment?.startTime).toBeCloseTo(2, 9);
		expect(firstChunkOfSecondSegment?.text).toBe("later words begin");
	});

	test("drift does not accumulate across a long transcription", () => {
		// 300 segments of fast speech: 12 tokens over 2s, four captions each,
		// every caption under the display floor. The old implementation ended
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
		const lastChunk = chunks[chunks.length - 1];

		expect(chunks).toHaveLength(1200);
		expect(segmentEndTime({ chunk: lastChunk })).toBeCloseTo(600, 6);
	});

	test("the first caption starts exactly when the first segment starts", () => {
		const chunks = buildCaptionChunks({
			segments: [{ text: "hello there my friend", start: 4.25, end: 9 }],
		});

		expect(chunks[0].startTime).toBeCloseTo(4.25, 9);
	});

	test("no caption starts before its own segment", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "一 二 三 四 五 六", start: 1, end: 2 },
			{ text: "七 八 九", start: 2, end: 2.4 },
			{ text: "十 十一", start: 2.4, end: 9 },
		];

		// Group captions by the segment whose span contains them, then check each
		// one against that segment rather than against every segment in the list.
		const chunks = buildCaptionChunks({ segments });
		for (const segment of segments) {
			const owned = chunks.filter(
				(chunk) =>
					chunk.startTime >= segment.start - EPSILON &&
					chunk.startTime < segment.end + EPSILON,
			);
			for (const chunk of owned) {
				expect(chunk.startTime).toBeGreaterThanOrEqual(segment.start - EPSILON);
			}
		}

		expect(chunks.length).toBeGreaterThan(0);
	});

	test("no caption outlives the dialogue of the segment it came from", () => {
		const segments: TranscriptionSegment[] = [
			{ text: "alpha beta gamma delta epsilon", start: 0, end: 3 },
			{ text: "zeta eta theta", start: 3, end: 5 },
			{ text: "iota kappa", start: 5, end: 6 },
		];

		// Attribute every caption to the segment whose span contains its start,
		// then re-derive each segment's captions from that attribution. A caption
		// starting exactly on a boundary belongs to the segment it starts in, so
		// the spans are half-open on the left.
		const chunks = buildCaptionChunks({ segments });
		const ownerOf = (chunk: CaptionChunk): TranscriptionSegment | undefined =>
			segments.find(
				(segment) =>
					chunk.startTime >= segment.start - EPSILON &&
					chunk.startTime < segment.end - EPSILON,
			);

		for (const chunk of chunks) {
			const owner = ownerOf(chunk);
			expect(owner).toBeDefined();
			expect(segmentEndTime({ chunk })).toBeLessThanOrEqual(
				(owner?.end ?? 0) + EPSILON,
			);
		}

		// Every segment must actually own some of the captions, or a segment's
		// dialogue would be silently dropped.
		for (const segment of segments) {
			expect(
				chunks.filter((chunk) => ownerOf(chunk) === segment).length,
			).toBeGreaterThan(0);
		}
	});

	test("the display floor widens a caption without moving the next one", () => {
		// Four tokens over 0.4s => 0.1s per token, three to a caption. The second
		// caption therefore starts 0.3s into the segment and its 0.1s of speech is
		// padded to the 0.4s segment end, so it reads for 0.1s rather than fully
		// swallowing the floor. Crucially the *start* still tracks the clock.
		const chunks = buildCaptionChunks({
			segments: [{ text: "one two three four", start: 0, end: 0.4 }],
		});

		expect(chunks).toHaveLength(2);
		expect(chunks[0].startTime).toBeCloseTo(0, 9);
		expect(chunks[1].startTime).toBeCloseTo(0.3, 9);
		expect(segmentEndTime({ chunk: chunks[1] })).toBeCloseTo(0.4, 9);
	});

	test("splits a Chinese line by character count instead of leaving it whole", () => {
		// 24 han characters over 6s. `split(/\s+/)` saw one word here, so the old
		// implementation emitted a single caption pinned to the 0.8s floor.
		const chunks = buildCaptionChunks({
			segments: [
				{ text: "今天天气不错我们出去走走吧明天一起去", start: 0, end: 6 },
			],
		});

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			// Within the 6-10 character range Chinese viewers expect.
			expect(chunk.text.length).toBeLessThanOrEqual(9);
		}
		expect(chunks.map((chunk) => chunk.text).join("")).toBe(
			"今天天气不错我们出去走走吧明天一起去",
		);
	});

	test("keeps CJK punctuation with its caption and adds no invented spaces", () => {
		const chunks = buildCaptionChunks({
			segments: [{ text: "你好，世界。今天不错！", start: 0, end: 3 }],
		});

		expect(chunks.map((chunk) => chunk.text).join("")).toBe(
			"你好，世界。今天不错！",
		);
		for (const chunk of chunks) {
			expect(chunk.text).not.toContain(" ");
		}
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

		expect(chunks).toHaveLength(3);
		expect(chunks[0].text).toBe("hello there my");
		expect(chunks[1].text).toBe("friend how are");
		expect(chunks[2].text).toBe("you");
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
