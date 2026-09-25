/**
 * Sample-index maths for exporting a sub-range of the timeline's audio.
 *
 * Kept free of `@/wasm` imports so it can be unit tested — `bun test` cannot
 * load `opencut-wasm` (see ./frame-window.ts for the same constraint on the
 * video side).
 */

/** Mirrors `TICKS_PER_SECOND` in rust/crates/time/src/media_time.rs. */
const TICKS_PER_SECOND = 120_000;

/**
 * Output length for an audio buffer covering `durationTicks`.
 *
 * Floored to whole samples, matching the pre-range behaviour of
 * `ceil(duration / TICKS_PER_SECOND * sampleRate)`.
 */
export function getAudioOutputLength({
	durationTicks,
	sampleRate,
}: {
	durationTicks: number;
	sampleRate: number;
}): number {
	const durationSeconds = durationTicks / TICKS_PER_SECOND;
	return Math.ceil(durationSeconds * sampleRate);
}

/**
 * Number of output samples the range start sits from the timeline's zero.
 *
 * Subtracting this from a clip's own output index rebases that clip onto the
 * range's zero. Computed in the *sample* domain rather than by re-deriving a
 * rebased `startTime`, which is what keeps pitch-preserved (retimed) clips
 * aligned: `mixAudioChannels` derives the source read position from `clipTime`,
 * and `clipTime` has to stay on the timeline's own clock. Rebasing the clip's
 * time instead would slide its read cursor along the resampled axis.
 */
export function getRangeOffsetSamples({
	rangeStartTicks,
	sampleRate,
}: {
	rangeStartTicks: number;
	sampleRate: number;
}): number {
	const rangeStartSeconds = rangeStartTicks / TICKS_PER_SECOND;
	return Math.floor(rangeStartSeconds * sampleRate);
}
