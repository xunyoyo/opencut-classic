import { mock } from "bun:test";

/**
 * Repo-wide stand-in for the vendored `opencut-wasm` package.
 *
 * The published 0.2.10 bundle cannot load under `bun test` here: its
 * wasm-bindgen glue calls `wasm.__wbindgen_start()`, which the bundled binary
 * does not export, so importing it throws before any test runs. That takes out
 * every module whose graph reaches `@/wasm` (including `@/timeline/defaults`,
 * and therefore the whole timeline and migration layers), which is the source of
 * the repo's pre-existing suite failures.
 *
 * Registered through `bunfig.toml`'s `[test] preload` rather than from
 * individual test files. `mock.module` mutates the module registry for the whole
 * process and is never undone, so registering it from a test file perturbs
 * evaluation order for every other file in the same run and produces
 * temporal-dead-zone failures elsewhere. One explicit registration, before
 * anything else loads, keeps the suite order-independent.
 *
 * FIDELITY: this is global test infrastructure, so the helpers below must match
 * the Rust implementation rather than merely satisfy the current callers. A stub
 * that returns plausible nonsense lets tests pass while asserting the wrong
 * thing — strictly worse than a loud failure. Where behaviour is genuinely out
 * of scope (the GPU/compositor stack), entries are inert no-ops and are listed
 * in the module comment below instead of being faked as correct.
 *
 * Mirrored semantics live in `rust/crates/time/src/media_time.rs` and
 * `rust/crates/time/src/frame_rate.rs`.
 */

/** `MediaTime` is an integer tick count; one second is 120_000 ticks. */
const TICKS_PER_SECOND = 120_000;

interface FrameRate {
	numerator: number;
	denominator: number;
}

/**
 * Ticks per frame, or `null` when the rate is invalid or does not land on a
 * whole tick — mirrors `FrameRate::ticks_per_frame`.
 */
function ticksPerFrame(rate: FrameRate): number | null {
	if (!(rate.numerator > 0 && rate.denominator > 0)) {
		return null;
	}

	const tickNumerator = TICKS_PER_SECOND * rate.denominator;
	if (tickNumerator % rate.numerator !== 0) {
		return null;
	}

	return tickNumerator / rate.numerator;
}

function floorToFrameTick({ time, rate }: { time: number; rate: FrameRate }) {
	const perFrame = ticksPerFrame(rate);
	if (perFrame === null) {
		return undefined;
	}
	return Math.floor(time / perFrame) * perFrame;
}

/**
 * Round-half-up on the frame grid, matching `to_frame_round`.
 *
 * The remainder is Euclidean on purpose: Rust uses `rem_euclid`, which is always
 * non-negative, whereas JS `%` takes the sign of the dividend. For negative
 * times the two disagree by a whole frame — `-1` tick at 30fps must round to
 * `-4000`, not `0`.
 */
function roundToFrameTick({ time, rate }: { time: number; rate: FrameRate }) {
	const perFrame = ticksPerFrame(rate);
	if (perFrame === null) {
		return undefined;
	}

	const floor = Math.floor(time / perFrame);
	const remainder = time - floor * perFrame;
	return (remainder * 2 >= perFrame ? floor + 1 : floor) * perFrame;
}

mock.module("opencut-wasm", () => ({
	// Faithful time helpers.
	TICKS_PER_SECOND: () => TICKS_PER_SECOND,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Number.isFinite(seconds) ? Math.round(seconds * TICKS_PER_SECOND) : undefined,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / TICKS_PER_SECOND,
	roundToFrame: ({ time, rate }: { time: number; rate: FrameRate }) =>
		roundToFrameTick({ time, rate }),
	floorToFrame: ({ time, rate }: { time: number; rate: FrameRate }) =>
		floorToFrameTick({ time, rate }),
	snappedSeekTime: ({
		time,
		duration,
		rate,
	}: {
		time: number;
		duration: number;
		rate: FrameRate;
	}) => {
		const snapped = roundToFrameTick({ time, rate });
		if (snapped === undefined) {
			return undefined;
		}
		return Math.min(Math.max(snapped, 0), duration);
	},
	lastFrameTime: ({
		duration,
		rate,
	}: {
		duration: number;
		rate: FrameRate;
	}) => {
		if (duration <= 0) {
			return 0;
		}
		return floorToFrameTick({ time: duration - 1, rate });
	},
	isFrameAligned: ({ time, rate }: { time: number; rate: FrameRate }) => {
		const perFrame = ticksPerFrame(rate);
		return perFrame === null ? undefined : time % perFrame === 0;
	},
	// Field names must match the generated ABI (`lhs` / `rhs`), not the wrapper's
	// own TS-internal `{ a, b }` spellings. A mismatch here does not throw — the
	// real argument is silently ignored and the stub returns NaN — so a test
	// would pass while asserting arithmetic we do not ship.
	mediaTimeAdd: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs + rhs,
	mediaTimeSub: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs - rhs,
	mediaTimeMin: ({ lhs, rhs }: { lhs: number; rhs: number }) => Math.min(lhs, rhs),
	mediaTimeMax: ({ lhs, rhs }: { lhs: number; rhs: number }) => Math.max(lhs, rhs),
	mediaTimeClamp: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(Math.max(time, min), max),
	mediaTimeFromFrame: ({ frame, rate }: { frame: number; rate: FrameRate }) => {
		const perFrame = ticksPerFrame(rate);
		return perFrame === null ? undefined : frame * perFrame;
	},
	mediaTimeToFrame: ({ time, rate }: { time: number; rate: FrameRate }) => {
		const perFrame = ticksPerFrame(rate);
		return perFrame === null ? undefined : BigInt(Math.floor(time / perFrame));
	},

	// Timecode formatting. Deliberately NOT reproduced: the real implementation
	// handles drop-frame and SMPTE variants, and a plausible-looking fake would
	// let a timecode test assert formatting we do not actually ship. Returns
	// `undefined` so any test that depends on it fails visibly.
	parseTimecode: () => undefined,
	formatTimecode: () => undefined,
	guessTimecodeFormat: () => undefined,

	// GPU / compositor surface. Inert no-ops, not faithful implementations —
	// nothing loads a real canvas, WebGPU device or texture under `bun test`.
	//
	// `initializeGpu` rejects rather than resolving: upstream
	// `initializeGpuRenderer` treats resolution as proof of a working adapter and
	// flips `gpuAvailable` to true, so a resolved stub silently inverts the
	// production "no GPU path" fallback. Rejecting keeps that flag honest and
	// makes any GPU-dependent test fail where it would in a headless browser.
	initializeGpu: async () => {
		throw new Error("GPU unavailable under `bun test` (wasm stub)");
	},
	initCompositor: () => {},
	resizeCompositor: () => {},
	renderFrame: () => {},
	applyEffectPasses: () => undefined,
	applyMaskFeather: () => undefined,
	getCompositorCanvas: () => undefined,
	getLastFrameProfile: () => [],
	releaseTexture: () => {},
	uploadTexture: () => {},

	// Referenced by the wasm-bindgen glue itself; a no-op keeps the module shape
	// complete so named imports always link.
	__wbindgen_start: () => {},
}));
