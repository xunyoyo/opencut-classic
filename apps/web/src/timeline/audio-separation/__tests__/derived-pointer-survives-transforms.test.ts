import { afterEach, describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	SceneTracks,
	TimelineElement,
	UploadAudioElement,
	VideoElement,
	VideoTrack,
} from "@/timeline/types";
import { EditorCore } from "@/core";
import { buildSeparatedAudioElement } from "@/timeline/audio-separation";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement(): VideoElement {
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
		isSourceAudioEnabled: true,
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

function buildDerivedAudio(): UploadAudioElement {
	return {
		id: "derived-1",
		type: "audio",
		sourceType: "upload",
		mediaId: "media-1",
		derivedFromElementId: "video-1",
		name: "clip",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 5000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 5000 }),
		params: { volume: 1, muted: false },
	};
}

function buildTracks(): SceneTracks {
	const main: VideoTrack = {
		id: "main",
		name: "main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [buildVideoElement()],
	};
	const audio: AudioTrack[] = [
		{
			id: "audio-1",
			name: "audio-1",
			type: "audio",
			muted: false,
			elements: [buildDerivedAudio()],
		},
	];
	return { overlay: [], main, audio };
}

/**
 * Installs a real `EditorCore` whose scene holds the given tracks. The real
 * singleton is used (not a stub) because these assertions run through the
 * actual timeline commands, which is the whole point — the pointer has to
 * survive the transforms those commands apply.
 */
function seedEditor() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	const tracks = buildTracks();
	const scene = {
		id: "scene-1",
		name: "Scene 1",
		isMain: true,
		tracks,
		bookmarks: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	editor.project.setActiveProject({
		project: {
			metadata: {
				id: "project-1",
				name: "probe",
				duration: mediaTime({ ticks: 5000 }),
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			scenes: [scene],
			currentSceneId: "scene-1",
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000000" },
			},
			version: 31,
		},
	});
	editor.scenes.setScenes({ scenes: [scene], activeSceneId: "scene-1" });
	return editor;
}

function isUploadAudioElement(
	element: TimelineElement,
): element is UploadAudioElement {
	return element.type === "audio" && element.sourceType === "upload";
}

function audioElementsOf({
	editor,
	trackId,
}: {
	editor: ReturnType<typeof seedEditor>;
	trackId: string;
}): UploadAudioElement[] {
	const track = editor.scenes
		.getActiveScene()
		.tracks.audio.find((candidate) => candidate.id === trackId);
	return (track?.elements ?? []).filter(isUploadAudioElement);
}

afterEach(() => {
	EditorCore.reset();
});

describe("derived audio pointer survives timeline transforms", () => {
	test("split copies the pointer onto both halves", () => {
		const editor = seedEditor();
		editor.timeline.splitElements({
			elements: [{ trackId: "audio-1", elementId: "derived-1" }],
			splitTime: mediaTime({ ticks: 2500 }),
			retainSide: "both",
		});

		const audioElements = audioElementsOf({ editor, trackId: "audio-1" });

		expect(audioElements.length).toBe(2);
		expect(
			audioElements.map((element) => element.derivedFromElementId),
		).toEqual(["video-1", "video-1"]);
	});

	test("cross-track move keeps the pointer", () => {
		const editor = seedEditor();
		const targetTrackId = "audio-2";

		// Seeded straight into the scene rather than via `addTrack`: the core
		// reactor prunes audio tracks with no elements, so a track created empty
		// is gone before the move can target it.
		const tracks = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks({
			...tracks,
			audio: [
				...tracks.audio,
				{
					id: targetTrackId,
					name: "audio-2",
					type: "audio",
					muted: false,
					elements: [
						{
							id: "sibling-1",
							type: "audio",
							sourceType: "upload",
							mediaId: "media-2",
							name: "other",
							startTime: mediaTime({ ticks: 20000 }),
							duration: mediaTime({ ticks: 1000 }),
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							params: { volume: 1, muted: false },
						},
					],
				},
			],
		});

		editor.timeline.moveElements({
			moves: [
				{
					elementId: "derived-1",
					sourceTrackId: "audio-1",
					targetTrackId,
					newStartTime: mediaTime({ ticks: 1000 }),
				},
			],
		});

		const moved = audioElementsOf({ editor, trackId: targetTrackId }).find(
			(element) => element.id === "derived-1",
		);

		expect(moved?.derivedFromElementId).toBe("video-1");
		expect(moved?.startTime).toBe(mediaTime({ ticks: 1000 }));
	});

	test("duplicate keeps the pointer", () => {
		const editor = seedEditor();
		editor.timeline.duplicateElements({
			elements: [{ trackId: "audio-1", elementId: "derived-1" }],
		});

		const copies = editor.scenes
			.getActiveScene()
			.tracks.audio.flatMap((track) => track.elements)
			.filter(isUploadAudioElement)
			.filter((element) => element.id !== "derived-1");

		expect(copies.length).toBe(1);
		expect(copies[0]?.derivedFromElementId).toBe("video-1");
	});

	test("a plain update preserves the pointer", () => {
		const editor = seedEditor();
		editor.timeline.updateElements({
			updates: [
				{
					trackId: "audio-1",
					elementId: "derived-1",
					patch: { startTime: mediaTime({ ticks: 500 }) },
				},
			],
		});

		const updated = audioElementsOf({ editor, trackId: "audio-1" })[0];

		expect(updated?.derivedFromElementId).toBe("video-1");
		expect(updated?.startTime).toBe(mediaTime({ ticks: 500 }));
	});

	test("insertElement carries a freshly built element's pointer", () => {
		const editor = seedEditor();
		const derived = buildSeparatedAudioElement({
			sourceElement: buildVideoElement(),
		});
		expect(derived.derivedFromElementId).toBe("video-1");

		editor.timeline.insertElement({
			element: derived,
			placement: { mode: "explicit", trackId: "audio-1" },
		});

		const inserted = audioElementsOf({ editor, trackId: "audio-1" }).find(
			(element) => element.id !== "derived-1",
		);

		expect(inserted?.derivedFromElementId).toBe("video-1");
	});
});
