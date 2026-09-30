import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";
import { type VideoSinkUsage, selectVideoSinksToEvict } from "./eviction";

interface VideoSinkData {
	input: Input;
	sink: CanvasSink;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;
}

/**
 * Opens a demuxer and a decoder on `file`. A parameter of the cache only so
 * its bookkeeping can be tested without decoding anything.
 */
export type OpenVideoSink = ({
	file,
}: {
	file: File;
}) => Promise<{ input: Input; sink: CanvasSink }>;

const openVideoSink: OpenVideoSink = async ({ file }) => {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) {
			throw new Error("No video track found");
		}

		const canDecode = await videoTrack.canDecode();
		if (!canDecode) {
			throw new Error("Video codec not supported for decoding");
		}

		const sink = new CanvasSink(videoTrack, {
			poolSize: 3,
			fit: "contain",
		});
		return { input, sink };
	} catch (error) {
		input.dispose();
		throw error;
	}
};

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();
	/**
	 * Which initialization may still register a sink for a media id.
	 * `clearVideo` drops the entry: an initialization that is still opening
	 * its sink at that point finds its generation gone and closes what it
	 * opened instead of registering it.
	 */
	private initGenerations = new Map<string, number>();
	private nextInitGeneration = 0;
	private frameChain = new Map<string, Promise<unknown>>();
	private seekGenerations = new Map<string, number>();
	private usage = new Map<string, VideoSinkUsage>();
	private openSink: OpenVideoSink;

	constructor({
		openSink = openVideoSink,
	}: {
		openSink?: OpenVideoSink;
	} = {}) {
		this.openSink = openSink;
	}

	async getFrameAt({
		mediaId,
		file,
		time,
	}: {
		mediaId: string;
		file: File;
		time: number;
	}): Promise<WrappedCanvas | null> {
		const usage = this.markRequestStarted({ mediaId });
		try {
			await this.ensureSink({ mediaId, file });

			// No sink also when `clearVideo` ran while this request was opening
			// one. Not reopened here: the request was made with the file that
			// was just let go of (a removed asset, or the heap copy an import
			// swapped for its stored file), and the next request brings the
			// current one.
			const sinkData = this.sinks.get(mediaId);
			if (!sinkData) return null;

			const generation = (this.seekGenerations.get(mediaId) ?? 0) + 1;
			this.seekGenerations.set(mediaId, generation);

			const previous = this.frameChain.get(mediaId) ?? Promise.resolve();
			const current = previous.then(() => {
				if (this.seekGenerations.get(mediaId) !== generation) {
					return sinkData.currentFrame ?? null;
				}
				return this.resolveFrame({ sinkData, time });
			});
			this.frameChain.set(
				mediaId,
				current.catch(() => {}),
			);
			return await current;
		} finally {
			usage.pendingRequests -= 1;
			usage.lastUsedAt = Date.now();
		}
	}

	private markRequestStarted({
		mediaId,
	}: {
		mediaId: string;
	}): VideoSinkUsage {
		let usage = this.usage.get(mediaId);
		if (!usage) {
			usage = { mediaId, lastUsedAt: 0, pendingRequests: 0 };
			this.usage.set(mediaId, usage);
		}
		usage.pendingRequests += 1;
		usage.lastUsedAt = Date.now();
		return usage;
	}

	/** Closes least-recently-used sinks beyond the bound; see `eviction.ts`. */
	private evictIdleSinks(): void {
		const open: VideoSinkUsage[] = [];
		for (const mediaId of this.sinks.keys()) {
			open.push(
				this.usage.get(mediaId) ?? {
					mediaId,
					lastUsedAt: 0,
					pendingRequests: 0,
				},
			);
		}

		for (const mediaId of selectVideoSinksToEvict({
			sinks: open,
			now: Date.now(),
		})) {
			this.clearVideo({ mediaId });
		}
	}

	private async resolveFrame({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;
				this.startPrefetch({ sinkData });
				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (sinkData.prefetching || !sinkData.iterator || sinkData.nextFrame) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		this.nextInitGeneration += 1;
		const generation = this.nextInitGeneration;
		this.initGenerations.set(mediaId, generation);
		const initPromise = this.initializeSink({ mediaId, file, generation });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			// Only while still current: after a `clearVideo` these entries may
			// already belong to a newer initialization for the same id.
			if (this.initGenerations.get(mediaId) === generation) {
				this.initGenerations.delete(mediaId);
				this.initPromises.delete(mediaId);
			}
		}
	}
	private async initializeSink({
		mediaId,
		file,
		generation,
	}: {
		mediaId: string;
		file: File;
		generation: number;
	}): Promise<void> {
		const { input, sink } = await this.openSink({ file }).catch((error) => {
			console.error(`Failed to initialize video sink for ${mediaId}:`, error);
			throw error;
		});

		if (this.initGenerations.get(mediaId) !== generation) {
			// Cleared while opening. Registering it anyway would put back a sink
			// on the file `clearVideo` let go of, with no usage record left, so
			// the eviction pass below would pick it straight away.
			input.dispose();
			return;
		}

		this.sinks.set(mediaId, {
			input,
			sink,
			iterator: null,
			currentFrame: null,
			nextFrame: null,
			lastTime: -1,
			prefetching: false,
			prefetchPromise: null,
		});
		this.evictIdleSinks();
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}

			sinkData.input.dispose();
			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
		this.initGenerations.delete(mediaId);
		this.frameChain.delete(mediaId);
		this.seekGenerations.delete(mediaId);
		this.usage.delete(mediaId);
	}

	clearAll(): void {
		// Sinks still opening are cleared too, or they would register once
		// open and outlive the clear.
		const mediaIds = [...this.sinks.keys(), ...this.initPromises.keys()];
		for (const mediaId of mediaIds) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
