import { describe, expect, test } from "bun:test";
import {
	type VideoSinkUsage,
	selectVideoSinksToEvict,
} from "@/services/video-cache/eviction";

const NOW = 1_000_000;

function sink({
	mediaId,
	idleFor,
	pendingRequests = 0,
}: {
	mediaId: string;
	idleFor: number;
	pendingRequests?: number;
}): VideoSinkUsage {
	return { mediaId, lastUsedAt: NOW - idleFor, pendingRequests };
}

describe("selectVideoSinksToEvict", () => {
	test("closes nothing while within the bound", () => {
		expect(
			selectVideoSinksToEvict({
				sinks: [
					sink({ mediaId: "a", idleFor: 60_000 }),
					sink({ mediaId: "b", idleFor: 60_000 }),
				],
				now: NOW,
				maxSinks: 2,
				idleMs: 1000,
			}),
		).toEqual([]);
	});

	test("closes the least recently used idle sinks down to the bound", () => {
		expect(
			selectVideoSinksToEvict({
				sinks: [
					sink({ mediaId: "newer", idleFor: 2000 }),
					sink({ mediaId: "oldest", idleFor: 9000 }),
					sink({ mediaId: "older", idleFor: 5000 }),
					sink({ mediaId: "current", idleFor: 0 }),
				],
				now: NOW,
				maxSinks: 2,
				idleMs: 1000,
			}),
		).toEqual(["oldest", "older"]);
	});

	// A frame that composites more videos than the bound needs every one of
	// them every frame; closing any would reopen it on the next frame.
	test("never closes a recently used sink, even past the bound", () => {
		expect(
			selectVideoSinksToEvict({
				sinks: [
					sink({ mediaId: "a", idleFor: 10 }),
					sink({ mediaId: "b", idleFor: 20 }),
					sink({ mediaId: "c", idleFor: 30 }),
				],
				now: NOW,
				maxSinks: 1,
				idleMs: 1000,
			}),
		).toEqual([]);
	});

	test("never closes a sink with a frame request in flight", () => {
		expect(
			selectVideoSinksToEvict({
				sinks: [
					sink({ mediaId: "busy", idleFor: 60_000, pendingRequests: 1 }),
					sink({ mediaId: "idle", idleFor: 30_000 }),
					sink({ mediaId: "current", idleFor: 0 }),
				],
				now: NOW,
				maxSinks: 1,
				idleMs: 1000,
			}),
		).toEqual(["idle"]);
	});
});
