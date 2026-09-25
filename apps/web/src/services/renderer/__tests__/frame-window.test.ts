import { describe, expect, test } from "bun:test";
import {
	EXPORT_TICKS_PER_SECOND,
	frameIndexToExportSeconds,
	frameIndexToTimelineTicks,
	resolveFrameWindow,
} from "../frame-window";

const TICKS_PER_SECOND = EXPORT_TICKS_PER_SECOND;
const FPS_30_TICKS_PER_FRAME = TICKS_PER_SECOND / 30; // 4000
const FPS_60_TICKS_PER_FRAME = TICKS_PER_SECOND / 60; // 2000

describe("resolveFrameWindow", () => {
	test("no range reproduces the previous floor(duration / ticksPerFrame) frame count", () => {
		// This is the regression assertion: before range support, the exporter
		// hard-coded `frameCount = Math.floor(rootNode.duration / ticksPerFrame)`
		// and started at frame 0. A full-timeline export must not change.
		const durationTicks = 10 * TICKS_PER_SECOND;
		const window = resolveFrameWindow({
			durationTicks,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: null,
		});

		expect(window.startFrame).toBe(0);
		expect(window.frameCount).toBe(
			Math.floor(durationTicks / FPS_30_TICKS_PER_FRAME),
		);
		expect(window.frameCount).toBe(300);
		expect(window.timelineOffsetTicks).toBe(0);
	});

	test("no range with a duration that is not frame aligned still floors", () => {
		// Established here because it is the one place the two modes differ:
		// 3.1 frames of duration. Floor → 3, which is what the exporter did
		// before range support existed. `ceil` would yield 4 and change the
		// output of every existing full-timeline export.
		const window = resolveFrameWindow({
			durationTicks: FPS_60_TICKS_PER_FRAME * 3 + 500,
			ticksPerFrame: FPS_60_TICKS_PER_FRAME,
			range: null,
		});

		expect(window.frameCount).toBe(3);
		expect(window.frameCount).toBeLessThan(
			Math.ceil((FPS_60_TICKS_PER_FRAME * 3 + 500) / FPS_60_TICKS_PER_FRAME),
		);
	});

	test("a frame-aligned range covers exactly its frame span", () => {
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			// seconds 2 → 5 at 30fps = frames 60 → 150
			range: { start: 2 * TICKS_PER_SECOND, end: 5 * TICKS_PER_SECOND },
		});

		expect(window.startFrame).toBe(60);
		expect(window.frameCount).toBe(90);
		expect(window.timelineOffsetTicks).toBe(2 * TICKS_PER_SECOND);
	});

	test("a range whose end is mid-frame includes the partially covered frame", () => {
		// End sits halfway through frame 90. Ceiling is deliberate: flooring
		// here would silently drop content the user framed.
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: {
				start: 2 * TICKS_PER_SECOND,
				end: 3 * TICKS_PER_SECOND + FPS_30_TICKS_PER_FRAME / 2,
			},
		});

		expect(window.startFrame).toBe(60);
		expect(window.frameCount).toBe(31); // frames 60..90 inclusive
	});

	test("start is floored so a mid-frame start begins at the covering frame", () => {
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: {
				start: 2 * TICKS_PER_SECOND + FPS_30_TICKS_PER_FRAME / 2,
				end: 5 * TICKS_PER_SECOND,
			},
		});

		expect(window.startFrame).toBe(60);
	});

	test("clamps a range end that runs past the timeline duration", () => {
		// A range can outlive its content — a trailing element may be deleted
		// after the range was drawn.
		const window = resolveFrameWindow({
			durationTicks: 3 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 1 * TICKS_PER_SECOND, end: 99 * TICKS_PER_SECOND },
		});

		expect(window.startFrame).toBe(30);
		expect(window.frameCount).toBe(60); // frames 30..90
	});

	test("a range starting past the (shrunken) duration yields zero frames", () => {
		const window = resolveFrameWindow({
			durationTicks: 1 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 5 * TICKS_PER_SECOND, end: 6 * TICKS_PER_SECOND },
		});

		expect(window.frameCount).toBe(0);
	});

	test("a degenerate (zero-length) range yields zero frames", () => {
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 2 * TICKS_PER_SECOND, end: 2 * TICKS_PER_SECOND },
		});

		expect(window.frameCount).toBe(0);
	});

	test("a negative start is clamped to zero", () => {
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: -1 * TICKS_PER_SECOND, end: 1 * TICKS_PER_SECOND },
		});

		expect(window.startFrame).toBe(0);
		expect(window.frameCount).toBe(30);
	});

	test("a range covering the whole timeline matches the no-range result", () => {
		const durationTicks = 10 * TICKS_PER_SECOND;
		const withRange = resolveFrameWindow({
			durationTicks,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 0, end: durationTicks },
		});
		const withoutRange = resolveFrameWindow({
			durationTicks,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: null,
		});

		expect(withRange).toEqual(withoutRange);
	});
});

describe("frameIndexToExportSeconds", () => {
	test("the first frame of a range maps to 0 on the export timeline", () => {
		// The load-bearing correctness property: mediabunny writes this value
		// straight through as the sample timestamp, so a non-zero result here
		// would encode leading padding instead of the framed content.
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 2 * TICKS_PER_SECOND, end: 5 * TICKS_PER_SECOND },
		});

		const firstSeconds = frameIndexToExportSeconds({
			frameIndex: window.startFrame,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			timelineOffsetTicks: window.timelineOffsetTicks,
		});

		expect(firstSeconds).toBe(0);
	});

	test("timestamps advance by one frame interval from the range start", () => {
		const start = 2 * TICKS_PER_SECOND;

		const atStart = frameIndexToExportSeconds({
			frameIndex: start / FPS_30_TICKS_PER_FRAME,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			timelineOffsetTicks: start,
		});
		const oneFrameLater = frameIndexToExportSeconds({
			frameIndex: start / FPS_30_TICKS_PER_FRAME + 1,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			timelineOffsetTicks: start,
		});

		expect(atStart).toBe(0);
		expect(oneFrameLater).toBeCloseTo(1 / 30, 10);
	});

	test("frame count and last timestamp are consistent", () => {
		// Encoding `frameCount` frames from `startFrame` must land the final
		// timestamp one interval short of the range end.
		const range = { start: 2 * TICKS_PER_SECOND, end: 5 * TICKS_PER_SECOND };
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range,
		});

		const lastSeconds = frameIndexToExportSeconds({
			frameIndex: window.startFrame + window.frameCount - 1,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			timelineOffsetTicks: window.timelineOffsetTicks,
		});

		expect(lastSeconds + 1 / 30).toBeCloseTo(3, 10); // 3s of content
	});

	test("no range keeps the original absolute mapping", () => {
		expect(
			frameIndexToExportSeconds({
				frameIndex: 90,
				ticksPerFrame: FPS_30_TICKS_PER_FRAME,
				timelineOffsetTicks: 0,
			}),
		).toBeCloseTo(3, 10);
	});
});

describe("frameIndexToTimelineTicks", () => {
	test("stays on the timeline clock so the renderer draws the framed content", () => {
		// The complement of the test above: the *renderer* must be asked for
		// absolute timeline time even though the muxer receives rebased time.
		// Getting these two the wrong way round yields a video whose images and
		// timestamps disagree.
		const window = resolveFrameWindow({
			durationTicks: 10 * TICKS_PER_SECOND,
			ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			range: { start: 2 * TICKS_PER_SECOND, end: 5 * TICKS_PER_SECOND },
		});

		expect(
			frameIndexToTimelineTicks({
				frameIndex: window.startFrame,
				ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			}),
		).toBe(2 * TICKS_PER_SECOND);

		expect(
			frameIndexToTimelineTicks({
				frameIndex: window.startFrame + 30,
				ticksPerFrame: FPS_30_TICKS_PER_FRAME,
			}),
		).toBe(3 * TICKS_PER_SECOND);
	});
});
