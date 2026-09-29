/**
 * How many decoders the video cache keeps open before it starts closing idle
 * ones.
 *
 * Every open sink pins a demuxer (whose `BlobSource` caches up to 8 MiB of the
 * file), a decoder and a pool of full-resolution canvases. Without a bound a
 * timeline of a few hundred clips opens one per clip as playback or export
 * walks past it and never closes any of them.
 */
export const MAX_IDLE_VIDEO_SINKS = 8;

/**
 * A sink used more recently than this is never closed, however many are open.
 *
 * This is what keeps the bound from thrashing: a frame that composites more
 * videos than `MAX_IDLE_VIDEO_SINKS` needs all of them every frame, and
 * closing one only to reopen it for the next frame would be far worse than
 * the memory it saves. Such sinks stay open past the bound until they idle.
 */
export const VIDEO_SINK_IDLE_MS = 5000;

export interface VideoSinkUsage {
	mediaId: string;
	lastUsedAt: number;
	/** Frame requests started against this sink and not yet settled. */
	pendingRequests: number;
}

/**
 * Picks which sinks to close, least recently used first, to bring the open
 * count back down to `maxSinks`. Sinks with a request in flight or used within
 * `idleMs` are never picked, so the result can leave more than `maxSinks` open.
 */
export function selectVideoSinksToEvict({
	sinks,
	now,
	maxSinks = MAX_IDLE_VIDEO_SINKS,
	idleMs = VIDEO_SINK_IDLE_MS,
}: {
	sinks: VideoSinkUsage[];
	now: number;
	maxSinks?: number;
	idleMs?: number;
}): string[] {
	const excess = sinks.length - maxSinks;
	if (excess <= 0) return [];

	return sinks
		.filter(
			(sink) => sink.pendingRequests === 0 && now - sink.lastUsedAt >= idleMs,
		)
		.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
		.slice(0, excess)
		.map((sink) => sink.mediaId);
}
