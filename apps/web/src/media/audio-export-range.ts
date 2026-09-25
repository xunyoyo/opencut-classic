/**
 * Range normalisation for the standalone audio export.
 *
 * Kept free of `@/wasm` and of Web Audio so it can be unit tested — the same
 * constraint that keeps `./audio-range.ts` importable from `bun test`.
 */

/** Mirrors `TICKS_PER_SECOND` in rust/crates/time/src/media_time.rs. */
const TICKS_PER_SECOND = 120_000;

export type AudioExportRangeTicks = { startTicks: number; endTicks: number };

/**
 * Clamps the caller's range to the timeline and reports the resulting span.
 *
 * A range is clamped rather than rejected: a selection dragged to the edge of
 * the ruler routinely ends past the last clip, and the video side clamps too.
 * Reversed input (`end` before `start`) is ordered rather than treated as an
 * error, so a UI that hands back a backwards drag still exports something.
 *
 * A collapsed or fully out-of-bounds range yields `durationTicks: 0` with no
 * range, which the caller reads as "nothing to export".
 */
export function resolveAudioExportRange({
	range,
	totalDuration,
}: {
	range?: { start: number; end: number };
	totalDuration: number;
}): {
	range: AudioExportRangeTicks | undefined;
	durationTicks: number;
} {
	if (!range) {
		return { range: undefined, durationTicks: Math.max(0, totalDuration) };
	}

	const startTicks = Math.max(0, Math.min(range.start, range.end));
	const endTicks = Math.min(
		Math.max(0, totalDuration),
		Math.max(range.start, range.end),
	);

	if (endTicks <= startTicks) {
		return { range: undefined, durationTicks: 0 };
	}

	return {
		range: { startTicks, endTicks },
		durationTicks: endTicks - startTicks,
	};
}

/**
 * Duration in ticks of a silent buffer standing in for "the project has no
 * audio at all". A zero-length buffer is not legal, so an empty timeline gets
 * the shortest representable one.
 */
export function getSilentDurationTicks({
	durationTicks,
}: {
	durationTicks: number;
}): number {
	const MIN_SILENT_DURATION_SECONDS = 0.001;
	return Math.max(
		Math.round(MIN_SILENT_DURATION_SECONDS * TICKS_PER_SECOND),
		durationTicks,
	);
}
