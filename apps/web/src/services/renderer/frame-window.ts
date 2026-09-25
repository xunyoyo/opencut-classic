/**
 * Frame-window maths for export, kept free of `@/wasm` imports so it can be
 * unit tested directly.
 *
 * `bun test` cannot load `opencut-wasm` (the bundler-target module calls
 * `__wbindgen_start`, which is undefined outside the bundler), so anything
 * importing a *value* from `@/wasm` is untestable here. That is why this module
 * carries its own `TICKS_PER_SECOND` (the same frozen-snapshot approach the
 * storage migrations use) and deals in plain integer ticks rather than the
 * branded `MediaTime`.
 */

// Mirrors `TICKS_PER_SECOND` in rust/crates/time/src/media_time.rs. Duplicated
// rather than imported so the tests can run without the wasm module.
export const EXPORT_TICKS_PER_SECOND = 120_000;

/**
 * The span of timeline this export covers, in absolute ticks. `null` means the
 * whole timeline.
 */
export interface ExportRangeTicks {
	start: number;
	end: number;
}

export interface FrameWindow {
	/** First frame index to render, in absolute timeline frames. */
	startFrame: number;
	/** Number of frames to encode. */
	frameCount: number;
	/**
	 * Absolute tick offset of `startFrame`. Timestamps handed to the muxer are
	 * measured from the *export file's* zero, so this is what gets subtracted to
	 * rebase them.
	 */
	timelineOffsetTicks: number;
}

/**
 * Resolves which frames an export should cover.
 *
 * The rounding of the end differs between the two modes, and deliberately so:
 *
 * - No range: `floor(duration / ticksPerFrame)`, reproducing the previous
 *   hard-coded behaviour exactly. This matters because `ceil` would *raise* the
 *   count for a non-frame-aligned duration (3.1 frames → 4), changing the
 *   output of every existing export.
 * - With a range: `ceil`, because a frame covering part of the range is still
 *   content the user framed; flooring would silently truncate the tail.
 *
 * The start is floored in both modes so a mid-frame start begins at the frame
 * that covers it.
 */
export function resolveFrameWindow({
	durationTicks,
	ticksPerFrame,
	range,
}: {
	durationTicks: number;
	ticksPerFrame: number;
	range: ExportRangeTicks | null;
}): FrameWindow {
	const clampedDuration = Math.max(0, durationTicks);

	if (ticksPerFrame <= 0) {
		return { startFrame: 0, frameCount: 0, timelineOffsetTicks: 0 };
	}

	const startFrame = range
		? Math.floor(Math.max(0, range.start) / ticksPerFrame)
		: 0;

	// Clamp rather than reject: the timeline can shrink under a live range when
	// a trailing element is deleted after the range was drawn.
	const endFrameIndex = range
		? Math.ceil(
				Math.min(
					clampedDuration,
					Math.max(Math.max(0, range.start), range.end),
				) / ticksPerFrame,
			)
		: Math.floor(clampedDuration / ticksPerFrame);

	const frameCount = Math.max(0, endFrameIndex - startFrame);

	return {
		startFrame,
		frameCount,
		timelineOffsetTicks: startFrame * ticksPerFrame,
	};
}

/**
 * Converts an absolute frame index into the timestamp the muxer expects.
 *
 * `CanvasSource.add()` writes the value through as the sample's presentation
 * time (mediabunny does not normalise it), so an absolute timestamp for a range
 * starting at 30s would be encoded as a 30-second run of empty padding. The
 * offset rebases absolute timeline time onto the export file's zero.
 */
export function frameIndexToExportSeconds({
	frameIndex,
	ticksPerFrame,
	timelineOffsetTicks,
}: {
	frameIndex: number;
	ticksPerFrame: number;
	timelineOffsetTicks: number;
}): number {
	const absoluteTicks = frameIndex * ticksPerFrame;
	return (absoluteTicks - timelineOffsetTicks) / EXPORT_TICKS_PER_SECOND;
}

/**
 * Absolute timeline ticks for a frame index. This is what the renderer is asked
 * to render — it must stay on the timeline's own clock, not the export's.
 */
export function frameIndexToTimelineTicks({
	frameIndex,
	ticksPerFrame,
}: {
	frameIndex: number;
	ticksPerFrame: number;
}): number {
	return frameIndex * ticksPerFrame;
}
