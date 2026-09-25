import { describe, expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import {
	clampRangeToDuration,
	getRangeDuration,
	isUsableRange,
	normalizeDragRange,
	snapRangeToFrames,
} from "../utils";

// The helpers under test take bare tick counts (see ../types), which is what
// lets this file run without `@/wasm` — that module cannot load under
// `bun test`.
const TICKS_PER_SECOND = 120_000;
const fps30: FrameRate = { numerator: 30, denominator: 1 };
const ticksPerFrame30 = TICKS_PER_SECOND / 30; // 4000

function ticks(value: number): number {
	return value;
}

describe("normalizeDragRange", () => {
	test("left-to-right drag keeps the endpoints as drawn", () => {
		const range = normalizeDragRange({
			anchor: ticks(0),
			cursor: ticks(5 * TICKS_PER_SECOND),
		});

		expect(range.start).toBe(0);
		expect(range.end).toBe(5 * TICKS_PER_SECOND);
	});

	test("right-to-left drag is ordered, not inverted", () => {
		// Dragging backwards is a normal gesture; downstream consumers assume
		// start < end.
		const range = normalizeDragRange({
			anchor: ticks(5 * TICKS_PER_SECOND),
			cursor: ticks(1 * TICKS_PER_SECOND),
		});

		expect(range.start).toBe(1 * TICKS_PER_SECOND);
		expect(range.end).toBe(5 * TICKS_PER_SECOND);
	});

	test("a zero-length drag yields an empty range rather than throwing", () => {
		const range = normalizeDragRange({ anchor: ticks(7), cursor: ticks(7) });
		expect(range.start).toBe(7);
		expect(range.end).toBe(7);
	});
});

describe("clampRangeToDuration", () => {
	test("leaves a range inside the timeline untouched", () => {
		const range = clampRangeToDuration({
			range: {
				start: ticks(TICKS_PER_SECOND),
				end: ticks(3 * TICKS_PER_SECOND),
			},
			duration: ticks(10 * TICKS_PER_SECOND),
		});

		expect(range.start).toBe(TICKS_PER_SECOND);
		expect(range.end).toBe(3 * TICKS_PER_SECOND);
	});

	test("clamps an end past the duration after the timeline shrinks", () => {
		// Deleting a trailing element shortens the timeline under a live range.
		const range = clampRangeToDuration({
			range: {
				start: ticks(TICKS_PER_SECOND),
				end: ticks(99 * TICKS_PER_SECOND),
			},
			duration: ticks(2 * TICKS_PER_SECOND),
		});

		expect(range.end).toBe(2 * TICKS_PER_SECOND);
		expect(range.start).toBe(TICKS_PER_SECOND);
	});

	test("collapses to a zero-length range when the whole range is past the end", () => {
		const range = clampRangeToDuration({
			range: {
				start: ticks(5 * TICKS_PER_SECOND),
				end: ticks(6 * TICKS_PER_SECOND),
			},
			duration: ticks(TICKS_PER_SECOND),
		});

		expect(range.start).toBe(TICKS_PER_SECOND);
		expect(range.end).toBe(TICKS_PER_SECOND);
	});

	test("clamps a negative start to zero", () => {
		const range = clampRangeToDuration({
			range: { start: ticks(-TICKS_PER_SECOND), end: ticks(TICKS_PER_SECOND) },
			duration: ticks(10 * TICKS_PER_SECOND),
		});

		expect(range.start).toBe(0);
		expect(range.end).toBe(TICKS_PER_SECOND);
	});
});

describe("snapRangeToFrames", () => {
	test("rounds endpoints onto the frame lattice", () => {
		const range = snapRangeToFrames({
			range: {
				start: ticks(ticksPerFrame30 + 100),
				end: ticks(ticksPerFrame30 * 5 + 100),
			},
			fps: fps30,
		});

		expect(range.start % ticksPerFrame30).toBe(0);
		expect(range.end % ticksPerFrame30).toBe(0);
		expect(range.start).toBe(ticksPerFrame30);
		expect(range.end).toBe(ticksPerFrame30 * 5);
	});

	test("rounds a remainder at or past the half-frame up", () => {
		// Mirrors Rust's `to_frame_round`: `remainder * 2 >= ticks_per_frame`
		// rounds away from zero. Exactly half a frame goes up.
		const halfFrame = ticksPerFrame30 / 2;

		expect(
			snapRangeToFrames({
				range: { start: ticks(0), end: ticks(ticksPerFrame30 * 5 + halfFrame) },
				fps: fps30,
			}).end,
		).toBe(ticksPerFrame30 * 6);

		expect(
			snapRangeToFrames({
				range: { start: ticks(0), end: ticks(ticksPerFrame30 * 5) },
				fps: fps30,
			}).end,
		).toBe(ticksPerFrame30 * 5);
	});

	test("does not collapse a sub-frame drag into a zero-length range", () => {
		// Rounding both endpoints of a tiny drag can land them on the same
		// frame boundary; the range must stay non-degenerate.
		const range = snapRangeToFrames({
			range: {
				start: ticks(ticksPerFrame30 + 10),
				end: ticks(ticksPerFrame30 + 20),
			},
			fps: fps30,
		});

		expect(range.end).toBeGreaterThan(range.start);
	});
});

describe("getRangeDuration", () => {
	test("measures the span", () => {
		expect(
			getRangeDuration({
				range: {
					start: ticks(2 * TICKS_PER_SECOND),
					end: ticks(5 * TICKS_PER_SECOND),
				},
			}),
		).toBe(3 * TICKS_PER_SECOND);
	});

	test("is zero for an empty range", () => {
		expect(
			getRangeDuration({
				range: { start: ticks(100), end: ticks(100) },
			}),
		).toBe(0);
	});
});

describe("isUsableRange", () => {
	test("rejects null", () => {
		expect(isUsableRange({ range: null })).toBe(false);
	});

	test("rejects a zero-length range", () => {
		expect(
			isUsableRange({
				range: { start: ticks(500), end: ticks(500) },
			}),
		).toBe(false);
	});

	test("accepts a positive span", () => {
		expect(
			isUsableRange({
				range: { start: ticks(0), end: ticks(1) },
			}),
		).toBe(true);
	});
});
