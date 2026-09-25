import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import {
	isDerivedFrom,
	removeDerivedAudioElements,
} from "@/timeline/audio-separation/remove-derived-audio";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

const ZERO = ZERO_MEDIA_TIME;

function buildUploadAudioElement({
	id,
	startTime,
	mediaId = "media-1",
	derivedFromElementId,
}: {
	id: string;
	startTime: number;
	mediaId?: string;
	derivedFromElementId?: string;
}): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId,
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO,
		trimEnd: ZERO,
		params: { volume: 1, muted: false },
		...(derivedFromElementId !== undefined && { derivedFromElementId }),
	};
}

function buildVideoElement({ id }: { id: string }): VideoElement {
	return {
		id,
		type: "video",
		name: id,
		startTime: ZERO,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO,
		trimEnd: ZERO,
		mediaId: "media-1",
		params: { volume: 1, muted: false },
	};
}

function buildTracks({
	mainElements = [],
	audioTracks,
}: {
	mainElements?: VideoElement[];
	audioTracks: AudioTrack[];
}): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "main",
		type: "video",
		muted: false,
		hidden: false,
		elements: mainElements,
	};

	return { overlay: [], main, audio: audioTracks };
}

describe("removeDerivedAudioElements", () => {
	test("removes the audio derived from the recovered element", () => {
		const tracks = buildTracks({
			audioTracks: [
				{
					id: "audio-1",
					name: "audio-1",
					type: "audio",
					muted: false,
					elements: [
						buildUploadAudioElement({
							id: "derived-1",
							startTime: 0,
							derivedFromElementId: "video-1",
						}),
					],
				},
			],
		});

		const result = removeDerivedAudioElements({
			tracks,
			sourceElementId: "video-1",
		});

		expect(result.audio[0]?.elements).toEqual([]);
	});

	test("keeps audio with no pointer even when mediaId and startTime match", () => {
		// The user's own copy of the same asset at the same offset. Without the
		// pointer there is no ownership evidence, so it must survive — guessing
		// here would delete their element.
		const tracks = buildTracks({
			audioTracks: [
				{
					id: "audio-1",
					name: "audio-1",
					type: "audio",
					muted: false,
					elements: [
						buildUploadAudioElement({
							id: "manual-1",
							startTime: 0,
							mediaId: "media-1",
						}),
					],
				},
			],
		});

		const result = removeDerivedAudioElements({
			tracks,
			sourceElementId: "video-1",
		});

		expect(result.audio[0]?.elements.map((element) => element.id)).toEqual([
			"manual-1",
		]);
	});

	test("keeps audio derived from a different source element", () => {
		const tracks = buildTracks({
			audioTracks: [
				{
					id: "audio-1",
					name: "audio-1",
					type: "audio",
					muted: false,
					elements: [
						buildUploadAudioElement({
							id: "derived-2",
							startTime: 0,
							derivedFromElementId: "video-2",
						}),
					],
				},
			],
		});

		const result = removeDerivedAudioElements({
			tracks,
			sourceElementId: "video-1",
		});

		expect(result.audio[0]?.elements.map((element) => element.id)).toEqual([
			"derived-2",
		]);
	});

	test("removes every derived element across tracks and ignores the video", () => {
		const tracks = buildTracks({
			mainElements: [buildVideoElement({ id: "video-1" })],
			audioTracks: [
				{
					id: "audio-1",
					name: "audio-1",
					type: "audio",
					muted: false,
					elements: [
						buildUploadAudioElement({
							id: "derived-1",
							startTime: 0,
							derivedFromElementId: "video-1",
						}),
						buildUploadAudioElement({
							id: "derived-2",
							startTime: 100,
							derivedFromElementId: "video-1",
						}),
						buildUploadAudioElement({ id: "manual-1", startTime: 200 }),
					],
				},
				{
					id: "audio-2",
					name: "audio-2",
					type: "audio",
					muted: false,
					elements: [
						buildUploadAudioElement({
							id: "derived-3",
							startTime: 0,
							derivedFromElementId: "video-1",
						}),
					],
				},
			],
		});

		const result = removeDerivedAudioElements({
			tracks,
			sourceElementId: "video-1",
		});

		expect(result.audio[0]?.elements.map((element) => element.id)).toEqual([
			"manual-1",
		]);
		expect(result.audio[1]?.elements).toEqual([]);
		expect(result.main.elements.map((element) => element.id)).toEqual([
			"video-1",
		]);
	});

	test("leaves the audio untouched when nothing is derived", () => {
		const tracks = buildTracks({
			audioTracks: [
				{
					id: "audio-1",
					name: "audio-1",
					type: "audio",
					muted: false,
					elements: [buildUploadAudioElement({ id: "manual-1", startTime: 0 })],
				},
			],
		});

		const result = removeDerivedAudioElements({
			tracks,
			sourceElementId: "video-1",
		});

		// Contents, not identity: the helper always rebuilds the audio tracks, so
		// an element survives by being copied through, not by reference.
		expect(result.audio[0]?.elements).toEqual(tracks.audio[0]?.elements);
	});
});

describe("isDerivedFrom", () => {
	test("is false for a video element id", () => {
		expect(
			isDerivedFrom({
				element: buildVideoElement({ id: "video-1" }),
				sourceElementId: "video-1",
			}),
		).toBe(false);
	});

	test("is true only for an exact pointer match", () => {
		expect(
			isDerivedFrom({
				element: buildUploadAudioElement({
					id: "derived-1",
					startTime: 0,
					derivedFromElementId: "video-1",
				}),
				sourceElementId: "video-1",
			}),
		).toBe(true);
		expect(
			isDerivedFrom({
				element: buildUploadAudioElement({
					id: "derived-1",
					startTime: 0,
					derivedFromElementId: "video-2",
				}),
				sourceElementId: "video-1",
			}),
		).toBe(false);
	});
});
