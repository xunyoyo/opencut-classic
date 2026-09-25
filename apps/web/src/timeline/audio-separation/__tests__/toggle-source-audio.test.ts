import { afterEach, describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type {
	AudioTrack,
	SceneTracks,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/element/toggle-source-audio-separation";
import { EditorCore } from "@/core";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

/**
 * The command reads exactly four things off `EditorCore`. Swapping the singleton
 * instance for a stub is cheaper and far less brittle than constructing the real
 * one, whose constructor drags in storage, canvas and GPU managers.
 */
function createFakeEditor({
	tracks,
	assets = [],
}: {
	tracks: SceneTracks;
	assets?: MediaAsset[];
}) {
	const state = { tracks };
	let commits = 0;
	const editor = {
		scenes: {
			getActiveScene: () => ({ tracks: state.tracks }),
		},
		timeline: {
			updateTracks: (next: SceneTracks) => {
				commits += 1;
				state.tracks = next;
			},
		},
		media: {
			getAssets: () => assets,
		},
	};
	// `instance` is private, so the assignment goes through a bag of unknown
	// keys rather than a narrowing assertion.
	Object.assign(EditorCore, { instance: editor });
	return {
		run({ trackId, elementId }: { trackId: string; elementId: string }) {
			const command = new ToggleSourceAudioSeparationCommand({
				trackId,
				elementId,
			});
			command.execute();
			return command;
		},
		getTracks: () => state.tracks,
		getCommits: () => commits,
	};
}

afterEach(() => {
	EditorCore.reset();
});

function mediaAsset({ id }: { id: string }): MediaAsset {
	return {
		id,
		name: id,
		type: "video",
		hasAudio: true,
		file: new File([], `${id}.mp4`),
	} as MediaAsset;
}

function buildVideoElement({
	isSourceAudioEnabled,
}: {
	isSourceAudioEnabled?: boolean;
}): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "clip",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 5000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 5000 }),
		mediaId: "media-1",
		...(isSourceAudioEnabled !== undefined && { isSourceAudioEnabled }),
		params: {
			volume: 1,
			muted: false,
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function buildDerivedAudio({
	id,
	derivedFromElementId,
}: {
	id: string;
	derivedFromElementId: string;
}): UploadAudioElement {
	return {
		id,
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		derivedFromElementId,
		name: "clip",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 5000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 5000 }),
		params: { volume: 1, muted: false },
	};
}

/** Same mediaId and offset as a derived element, but with no pointer. */
function buildManualAudio({ id }: { id: string }): UploadAudioElement {
	const { derivedFromElementId: _unused, ...rest } = buildDerivedAudio({
		id,
		derivedFromElementId: "unused",
	});
	return rest;
}

function isUploadAudioElement(
	element: TimelineElement,
): element is UploadAudioElement {
	return element.type === "audio" && element.sourceType === "upload";
}

function buildTracks({
	video,
	audioTracks,
}: {
	video: VideoElement;
	audioTracks: AudioTrack[];
}): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [video],
	};
	return { overlay: [], main, audio: audioTracks };
}

function audioTrack({
	id,
	elements,
}: {
	id: string;
	elements: UploadAudioElement[];
}): AudioTrack {
	return {
		id,
		name: id,
		type: "audio",
		muted: false,
		elements,
	};
}

function allAudio(tracks: SceneTracks): UploadAudioElement[] {
	return tracks.audio
		.flatMap((track) => track.elements)
		.filter(isUploadAudioElement);
}

function mainVideo(tracks: SceneTracks): VideoElement {
	const element = tracks.main.elements.find(
		(candidate): candidate is VideoElement => candidate.type === "video",
	);
	if (!element) {
		throw new Error("Expected a video element on the main track");
	}
	return element;
}

/** The separated state the QA report starts from. */
function separatedTracks({
	audioTracks,
}: {
	audioTracks: AudioTrack[];
}): SceneTracks {
	return buildTracks({
		video: buildVideoElement({ isSourceAudioEnabled: false }),
		audioTracks,
	});
}

describe("recovering extracted audio", () => {
	test("removes the derived audio and re-enables the source in one commit", () => {
		const fake = createFakeEditor({
			tracks: separatedTracks({
				audioTracks: [
					audioTrack({
						id: "audio-1",
						elements: [
							buildDerivedAudio({
								id: "derived-1",
								derivedFromElementId: "video-1",
							}),
						],
					}),
				],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });

		const tracks = fake.getTracks();
		expect(mainVideo(tracks).isSourceAudioEnabled).toBe(true);
		// The regression: the derived element used to survive recovery, leaving
		// two audible copies of the same audio stacked at identical offsets.
		expect(allAudio(tracks).length).toBe(0);
		// One user action, one write — a split commit would stack two undo steps.
		expect(fake.getCommits()).toBe(1);
	});

	test("keeps a same-media audio element that carries no pointer", () => {
		const fake = createFakeEditor({
			tracks: separatedTracks({
				audioTracks: [
					audioTrack({
						id: "audio-1",
						elements: [
							buildDerivedAudio({
								id: "derived-1",
								derivedFromElementId: "video-1",
							}),
							// Same mediaId, same offset, no pointer: the user's own copy.
							// Inferring ownership from mediaId + startTime would delete it.
							buildManualAudio({ id: "manual-1" }),
						],
					}),
				],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });

		expect(allAudio(fake.getTracks()).map((element) => element.id)).toEqual([
			"manual-1",
		]);
	});

	test("keeps audio derived from a different source element", () => {
		const fake = createFakeEditor({
			tracks: separatedTracks({
				audioTracks: [
					audioTrack({
						id: "audio-1",
						elements: [
							buildDerivedAudio({
								id: "derived-1",
								derivedFromElementId: "video-1",
							}),
							buildDerivedAudio({
								id: "derived-other",
								derivedFromElementId: "video-2",
							}),
						],
					}),
				],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });

		expect(allAudio(fake.getTracks()).map((element) => element.id)).toEqual([
			"derived-other",
		]);
	});

	test("extract then recover round-trips to a single source of audio", () => {
		const fake = createFakeEditor({
			tracks: buildTracks({
				video: buildVideoElement({ isSourceAudioEnabled: true }),
				audioTracks: [],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });
		expect(mainVideo(fake.getTracks()).isSourceAudioEnabled).toBe(false);
		expect(allAudio(fake.getTracks()).length).toBe(1);
		expect(allAudio(fake.getTracks())[0]?.derivedFromElementId).toBe("video-1");

		fake.run({ trackId: "main", elementId: "video-1" });
		expect(mainVideo(fake.getTracks()).isSourceAudioEnabled).toBe(true);
		expect(allAudio(fake.getTracks()).length).toBe(0);
	});

	test("extract then recover twice never stacks audio", () => {
		const fake = createFakeEditor({
			tracks: buildTracks({
				video: buildVideoElement({ isSourceAudioEnabled: true }),
				audioTracks: [],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		for (let round = 0; round < 2; round += 1) {
			fake.run({ trackId: "main", elementId: "video-1" });
			fake.run({ trackId: "main", elementId: "video-1" });
		}

		expect(mainVideo(fake.getTracks()).isSourceAudioEnabled).toBe(true);
		expect(allAudio(fake.getTracks()).length).toBe(0);
	});

	test("undo restores the fully separated state", () => {
		const fake = createFakeEditor({
			tracks: buildTracks({
				video: buildVideoElement({ isSourceAudioEnabled: true }),
				audioTracks: [],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });
		const recoverCommand = fake.run({ trackId: "main", elementId: "video-1" });
		expect(allAudio(fake.getTracks()).length).toBe(0);

		recoverCommand.undo();

		const tracks = fake.getTracks();
		expect(mainVideo(tracks).isSourceAudioEnabled).toBe(false);
		expect(allAudio(tracks).length).toBe(1);
		expect(allAudio(tracks)[0]?.derivedFromElementId).toBe("video-1");
	});

	test("legacy audio without a pointer is left in place", () => {
		// Separated before the pointer existed: no way to attribute it, and
		// guessing would risk deleting a user's own element.
		const fake = createFakeEditor({
			tracks: separatedTracks({
				audioTracks: [
					audioTrack({
						id: "audio-1",
						elements: [buildManualAudio({ id: "legacy-1" })],
					}),
				],
			}),
			assets: [mediaAsset({ id: "media-1" })],
		});

		fake.run({ trackId: "main", elementId: "video-1" });

		const tracks = fake.getTracks();
		expect(mainVideo(tracks).isSourceAudioEnabled).toBe(true);
		expect(allAudio(tracks).map((element) => element.id)).toEqual(["legacy-1"]);
	});
});
