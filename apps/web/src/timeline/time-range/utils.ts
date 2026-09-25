import type { FrameRate } from "opencut-wasm";
import type { TickSpan } from "./types";

/**
 * Pure range maths, free of `@/wasm` imports so it can be unit tested —
 * `bun test` cannot load `opencut-wasm` (the bundler-target module calls
 * `__wbindgen_start`, undefined outside the bundler). Keeping the quantisation
 * rules here rather than leaning on `roundFrameTime` also means the tests pin
 * the rounding *semantics* rather than one wasm binding.
 */

// Mirrors `TICKS_PER_SECOND` in rust/crates/time/src/media_time.rs.
const TICKS_PER_SECOND = 120_000;

function ticksPerFrameFrom({ fps }: { fps: FrameRate }): number {
	return Math.round((TICKS_PER_SECOND * fps.denominator) / fps.numerator);
}

/**
 * Rounds a tick count to the nearest frame boundary, half away from zero.
 *
 * Matches `MediaTime::to_frame_round` in rust (which compares
 * `remainder * 2 >= ticks_per_frame`) rather than `Math.round`, whose
 * `-0.5 → -0` quirk would leave a negative zero in stored state.
 */
function roundTicksToFrame({
	ticks,
	fps,
}: {
	ticks: number;
	fps: FrameRate;
}): number {
	const ticksPerFrame = ticksPerFrameFrom({ fps });
	if (ticksPerFrame <= 0) return ticks;

	const remainder = ((ticks % ticksPerFrame) + ticksPerFrame) % ticksPerFrame;
	const floor = Math.floor(ticks / ticksPerFrame);
	const frame = remainder * 2 >= ticksPerFrame ? floor + 1 : floor;
	return frame * ticksPerFrame;
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}) {
	return Math.min(Math.max(value, min), max);
}

/**
 * Orders two drag endpoints into a range.
 *
 * Dragging right-to-left is a normal way to frame a selection, but every
 * consumer downstream (frame window maths, audio offset, the highlight layer)
 * assumes `start < end`. Normalising once here is what keeps that assumption
 * from having to be re-checked at each of those sites.
 */
export function normalizeDragRange({
	anchor,
	cursor,
}: {
	anchor: number;
	cursor: number;
}): {
	start: number;
	end: number;
} {
	return anchor <= cursor
		? { start: anchor, end: cursor }
		: { start: cursor, end: anchor };
}

/**
 * Clamps a range into `[0, duration]`.
 *
 * A range can outlive the content it was drawn over: deleting a trailing
 * element shortens the timeline, and an export range that still points past the
 * new end would otherwise be clamped deep inside the frame-window maths, where
 * the reason is no longer visible.
 *
 * Generic over the tick type so a caller holding branded `MediaTime` gets
 * `MediaTime` back, while the wasm-free tests pass plain numbers.
 */
export function clampRangeToDuration<T extends { start: number; end: number }>({
	range,
	duration,
}: {
	range: T;
	duration: number;
}): T {
	const end = clamp({ value: range.end, min: 0, max: Math.max(0, duration) });
	const start = clamp({ value: range.start, min: 0, max: end });
	return { ...range, start, end };
}

/**
 * Quantises both endpoints onto the frame lattice.
 *
 * Export walks frames, so a range whose endpoints sit mid-frame has no single
 * correct interpretation. Snapping at the point of creation (rather than during
 * export) means what the user sees highlighted is what gets encoded.
 */
export function snapRangeToFrames({
	range,
	fps,
}: {
	range: { start: number; end: number };
	fps: FrameRate;
}): { start: number; end: number } {
	const start = roundTicksToFrame({ ticks: range.start, fps });
	const end = roundTicksToFrame({ ticks: range.end, fps });

	// Rounding can collapse a sub-frame drag onto one boundary; keep `start`
	// strictly below `end` so the range stays non-degenerate.
	if (start >= end) {
		const ticksPerFrame = ticksPerFrameFrom({ fps });
		return { start, end: start + ticksPerFrame };
	}

	return { start, end };
}

export function getRangeDuration({
	range,
}: {
	range: { start: number; end: number };
}): number {
	return range.end - range.start;
}

/**
 * Whether a range is worth exporting. A zero-length one would encode no frames,
 * so the UI treats it as "no selection" rather than offering a dead button.
 */
export function isUsableRange({ range }: { range: TickSpan | null }): boolean {
	if (!range) return false;
	return range.end > range.start;
}
