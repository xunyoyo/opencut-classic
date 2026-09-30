import { describe, expect, test } from "bun:test";
import type { CanvasSink, Input, WrappedCanvas } from "mediabunny";
import { type OpenVideoSink, VideoCache } from "@/services/video-cache/service";

/**
 * A sink whose opening is held until the test releases it, so a `clearVideo`
 * can be placed while it is still in flight. Every frame it decodes is a fixed
 * one-second frame at the requested time.
 */
function createControlledOpener() {
	const opened: Array<{ file: File; disposed: boolean }> = [];
	const releases: Array<() => void> = [];

	const openSink: OpenVideoSink = async ({ file }) => {
		const record = { file, disposed: false };
		opened.push(record);
		await new Promise<void>((resolve) => releases.push(resolve));

		const input = {
			dispose: () => {
				record.disposed = true;
			},
		} as unknown as Input;
		const sink = {
			canvases: async function* (time: number) {
				yield {
					canvas: { width: 16, height: 9 },
					timestamp: time,
					duration: 1,
				} as unknown as WrappedCanvas;
			},
		} as unknown as CanvasSink;
		return { input, sink };
	};

	return {
		openSink,
		opened,
		releaseNext: async () => {
			releases.shift()?.();
			// Lets the opener's continuation and the cache's registration run.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

const heapFile = new File([new Uint8Array(8)], "heap.mp4");
const storedFile = new File([new Uint8Array(8)], "stored.mp4");

describe("VideoCache.clearVideo during sink initialization", () => {
	test("does not register the sink that was opening when it ran", async () => {
		const opener = createControlledOpener();
		const cache = new VideoCache({ openSink: opener.openSink });

		const request = cache.getFrameAt({
			mediaId: "a",
			file: heapFile,
			time: 0,
		});
		cache.clearVideo({ mediaId: "a" });
		await opener.releaseNext();

		// The request that raced the clear comes back empty instead of
		// hanging or throwing, and what it opened is closed, not kept.
		expect(await request).toBeNull();
		expect(opener.opened[0].disposed).toBe(true);
		expect(cache.getStats().totalSinks).toBe(0);
	});

	test("reopens on the file of the next request", async () => {
		const opener = createControlledOpener();
		const cache = new VideoCache({ openSink: opener.openSink });

		const stale = cache.getFrameAt({ mediaId: "a", file: heapFile, time: 0 });
		cache.clearVideo({ mediaId: "a" });
		const fresh = cache.getFrameAt({
			mediaId: "a",
			file: storedFile,
			time: 0,
		});

		await opener.releaseNext();
		await opener.releaseNext();

		expect(await stale).toBeNull();
		expect((await fresh)?.timestamp).toBe(0);
		expect(opener.opened.map((record) => record.file)).toEqual([
			heapFile,
			storedFile,
		]);
		expect(opener.opened[0].disposed).toBe(true);
		expect(opener.opened[1].disposed).toBe(false);
		expect(cache.getStats().totalSinks).toBe(1);
	});

	test("a stale initialization finishing late leaves the newer one in place", async () => {
		const opener = createControlledOpener();
		const cache = new VideoCache({ openSink: opener.openSink });

		const stale = cache.getFrameAt({ mediaId: "a", file: heapFile, time: 0 });
		cache.clearVideo({ mediaId: "a" });
		const fresh = cache.getFrameAt({
			mediaId: "a",
			file: storedFile,
			time: 0,
		});
		// A third request made while the second is opening must wait for it
		// rather than open a duplicate: the stale one finishing first must not
		// have dropped the newer pending entry.
		await opener.releaseNext();
		const joined = cache.getFrameAt({
			mediaId: "a",
			file: storedFile,
			time: 0.5,
		});
		await opener.releaseNext();

		expect(await stale).toBeNull();
		// `fresh` is superseded by the newer seek and may come back empty by
		// design; `joined` is served from the one sink both waited on.
		await fresh;
		expect(await joined).not.toBeNull();
		expect(opener.opened).toHaveLength(2);
		expect(cache.getStats().totalSinks).toBe(1);
	});

	test("clearAll also cancels sinks that are still opening", async () => {
		const opener = createControlledOpener();
		const cache = new VideoCache({ openSink: opener.openSink });

		const request = cache.getFrameAt({
			mediaId: "a",
			file: heapFile,
			time: 0,
		});
		cache.clearAll();
		await opener.releaseNext();

		expect(await request).toBeNull();
		expect(opener.opened[0].disposed).toBe(true);
		expect(cache.getStats().totalSinks).toBe(0);
	});

	test("an uninterrupted initialization registers and serves the frame", async () => {
		const opener = createControlledOpener();
		const cache = new VideoCache({ openSink: opener.openSink });

		const request = cache.getFrameAt({
			mediaId: "a",
			file: storedFile,
			time: 2,
		});
		await opener.releaseNext();

		expect((await request)?.timestamp).toBe(2);
		expect(opener.opened[0].disposed).toBe(false);
		expect(cache.getStats().totalSinks).toBe(1);
	});
});
