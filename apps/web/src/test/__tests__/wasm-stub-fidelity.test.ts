import { describe, expect, test } from "bun:test";
import {
	TICKS_PER_SECOND,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundFrameTicks,
	snapSeekMediaTime,
	lastFrameMediaTime,
	mediaTime,
} from "@/wasm";

const FPS_30 = { numerator: 30, denominator: 1 };
const FPS_5 = { numerator: 5, denominator: 1 };

/**
 * These pin the global test stub (`apps/web/src/test/wasm-test-stub.ts`) to the
 * shipped Rust semantics. Without them a drifting stub would silently change
 * what every other test in the suite is asserting.
 */
describe("wasm test stub fidelity", () => {
	test("tick rate matches the Rust constant", () => {
		// rust/crates/time/src/media_time.rs:10
		expect(TICKS_PER_SECOND).toBe(120_000);
	});

	test("seconds round-trip at the real tick rate", () => {
		expect(mediaTimeFromSeconds({ seconds: 1 })).toBe(
			mediaTime({ ticks: 120_000 }),
		);
		expect(mediaTimeFromSeconds({ seconds: 1.5 })).toBe(
			mediaTime({ ticks: 180_000 }),
		);
		expect(mediaTimeToSeconds({ time: mediaTime({ ticks: 120_000 }) })).toBe(1);
	});

	test("rounds to the nearest 30fps frame (4000 ticks per frame)", () => {
		expect(roundFrameTicks({ ticks: 0, fps: FPS_30 })).toBe(0);
		expect(roundFrameTicks({ ticks: 3_999, fps: FPS_30 })).toBe(4_000);
		expect(roundFrameTicks({ ticks: 2_000, fps: FPS_30 })).toBe(4_000);
		expect(roundFrameTicks({ ticks: 1_999, fps: FPS_30 })).toBe(0);
		expect(roundFrameTicks({ ticks: 6_000, fps: FPS_30 })).toBe(8_000);
	});

	test("rounds negative times with Euclidean remainders, like rem_euclid", () => {
		// Rust uses div_euclid/rem_euclid, so the remainder is always
		// non-negative and it floors toward negative infinity. JS `%` takes the
		// dividend's sign and would give -1 and -4000 here instead of 0 and -4000.
		expect(roundFrameTicks({ ticks: -1, fps: FPS_30 })).toBe(0);
		expect(roundFrameTicks({ ticks: -2_000, fps: FPS_30 })).toBe(0);
		expect(roundFrameTicks({ ticks: -2_001, fps: FPS_30 })).toBe(-4_000);
		expect(roundFrameTicks({ ticks: -4_000, fps: FPS_30 })).toBe(-4_000);
		expect(roundFrameTicks({ ticks: -4_001, fps: FPS_30 })).toBe(-4_000);
	});

	test("snapSeekMediaTime rounds then clamps into [0, duration]", () => {
		const duration = mediaTime({ ticks: 120_000 });
		expect(
			snapSeekMediaTime({
				time: mediaTime({ ticks: 3_999 }),
				duration,
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 4_000 }));
		expect(
			snapSeekMediaTime({
				time: mediaTime({ ticks: 999_999 }),
				duration,
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 120_000 }));
		expect(
			snapSeekMediaTime({
				time: mediaTime({ ticks: -500 }),
				duration,
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 0 }));
	});

	test("lastFrameMediaTime floors the last inclusive tick", () => {
		expect(
			lastFrameMediaTime({
				duration: mediaTime({ ticks: 120_000 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 116_000 }));
		expect(
			lastFrameMediaTime({ duration: mediaTime({ ticks: 0 }), fps: FPS_30 }),
		).toBe(mediaTime({ ticks: 0 }));
		expect(
			lastFrameMediaTime({
				duration: mediaTime({ ticks: 4_000 }),
				fps: FPS_30,
			}),
		).toBe(mediaTime({ ticks: 0 }));
	});

	test("invalid frame rates fall back rather than reporting a fake tick", () => {
		// The wrapper treats None as "leave the value alone", so an invalid rate
		// must not silently snap to a frame.
		expect(
			roundFrameTicks({ ticks: 1_000, fps: { numerator: 0, denominator: 1 } }),
		).toBe(1_000);
	});
});

describe("stub matches the generated wasm ABI", () => {
	// The generated `opencut_wasm.d.ts` is the contract the real package satisfies.
	// Reading it is not enough — passing the real options objects through the stub
	// is what proves the field names line up, because a typo there yields NaN
	// instead of an exception.
	test("add/sub/min/max take lhs/rhs, not the wrapper's a/b", async () => {
		const wasm = await import("opencut-wasm");

		expect(
			wasm.mediaTimeAdd({
				lhs: mediaTime({ ticks: 1_000 }),
				rhs: mediaTime({ ticks: 2_000 }),
			}),
		).toBe(3_000);
		expect(
			wasm.mediaTimeSub({
				lhs: mediaTime({ ticks: 5_000 }),
				rhs: mediaTime({ ticks: 2_000 }),
			}),
		).toBe(3_000);
		expect(
			wasm.mediaTimeMin({
				lhs: mediaTime({ ticks: 1_000 }),
				rhs: mediaTime({ ticks: 2_000 }),
			}),
		).toBe(1_000);
		expect(
			wasm.mediaTimeMax({
				lhs: mediaTime({ ticks: 1_000 }),
				rhs: mediaTime({ ticks: 2_000 }),
			}),
		).toBe(2_000);
	});

	test("mediaTimeToFrame returns a bigint, like the real Option<i64> export", async () => {
		const wasm = await import("opencut-wasm");

		// `BigInt(...)` rather than a `2n` literal: the project targets ES2017,
		// where bigint literals are a syntax error. `typeof` is asserted too —
		// the number 2 is `==` but not `===` to 2n, and the point of this test is
		// the type, not just the value.
		const frame = wasm.mediaTimeToFrame({
			time: mediaTime({ ticks: 8_000 }),
			rate: FPS_30,
		});
		expect(typeof frame).toBe("bigint");
		expect(frame).toBe(BigInt(2));
	});

	test("initializeGpu rejects so the caller does not claim a live adapter", async () => {
		// gpu-renderer flips `gpuAvailable` to true on resolve; a resolving stub
		// would assert the opposite of production in a headless test run.
		const wasm = await import("opencut-wasm");

		await expect(wasm.initializeGpu()).rejects.toThrow();
	});
});

describe("stub matches the Rust unit tests", () => {
	// Values lifted from `mod tests` in rust/crates/time/src/media_time.rs, so
	// these pin the stub to the shipped implementation rather than to my own
	// reading of it.
	test("converts_between_seconds_and_ticks", () => {
		expect(mediaTimeFromSeconds({ seconds: 1.5 })).toBe(
			mediaTime({ ticks: 180_000 }),
		);
		expect(mediaTimeToSeconds({ time: mediaTime({ ticks: 180_000 }) })).toBe(
			1.5,
		);
	});

	test("snaps_to_the_nearest_frame at 1.26s / 30fps", () => {
		// 1.26s -> 151200 ticks -> frame 38 -> 152000 ticks
		expect(roundFrameTicks({ ticks: 151_200, fps: FPS_30 })).toBe(152_000);
	});

	test("floors_to_frame around the half-frame boundary", () => {
		const ticksPerFrame = 4_000;
		expect(roundFrameTicks({ ticks: ticksPerFrame * 5 + 1, fps: FPS_30 })).toBe(
			ticksPerFrame * 5,
		);
		expect(
			roundFrameTicks({
				ticks: ticksPerFrame * 5 + ticksPerFrame / 2,
				fps: FPS_30,
			}),
		).toBe(ticksPerFrame * 6);
	});

	test("computes_last_frame_time_and_snapped_seek_time at 5fps", () => {
		const duration = mediaTimeFromSeconds({ seconds: 10 });

		// 10s at 5fps: last inclusive tick 1199999 floors to 1176000 (9.8s)
		expect(lastFrameMediaTime({ duration, fps: FPS_5 })).toBe(
			mediaTimeFromSeconds({ seconds: 9.8 }),
		);
		expect(
			snapSeekMediaTime({
				time: mediaTimeFromSeconds({ seconds: 10 }),
				duration,
				fps: FPS_5,
			}),
		).toBe(mediaTimeFromSeconds({ seconds: 10 }));
	});
});
