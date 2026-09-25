import { describe, expect, test } from "bun:test";
import { buildLiveScene, buildSceneTracks, buildSnapshot } from "./fixtures";
import type { TProject } from "@/project/types";

/**
 * Loaded dynamically because these modules are still being defined when the
 * file's own imports run — `@/versions/serialize` pulls tick math in through
 * `@/wasm`, and the deferred import keeps that graph out of the import phase.
 */
const { mediaTime, ZERO_MEDIA_TIME } = await import("@/wasm");
const {
	getDurationSourceScene,
	serializeProject,
	serializeProjectMetadata,
	serializeScenes,
	stripAudioBuffers,
} = await import("@/versions/serialize");

/**
 * Tick math comes from the repo-wide wasm stub registered in
 * `bunfig.toml`'s preload (`src/test/wasm-test-stub.ts`), which reproduces
 * integer-tick semantics, so these tests still check the real contract: a
 * `MediaTime` crossing the codec must stay an integer tick count, and dates
 * must become strings.
 */

function buildProject(): TProject {
	return {
		metadata: {
			id: "project-1",
			name: "测试项目",
			duration: mediaTime({ ticks: 500 }),
			createdAt: new Date("2024-01-01T00:00:00.000Z"),
			updatedAt: new Date("2024-01-02T00:00:00.000Z"),
			saturnProjectId: 42,
			saturnLaidOut: true,
		},
		scenes: [buildLiveScene()],
		currentSceneId: "scene-1",
		settings: buildSnapshot().settings,
		version: 31,
		timelineViewState: {
			zoomLevel: 1,
			scrollLeft: 0,
			playheadTime: ZERO_MEDIA_TIME,
		},
	};
}

describe("version snapshot serialization", () => {
	test("round-trips a project through serialization without loss", () => {
		const project = buildProject();
		const serialized = serializeProject({
			project,
			duration: project.metadata.duration,
		});

		expect(serialized.metadata).toMatchObject({
			id: "project-1",
			name: "测试项目",
			duration: 500,
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-02T00:00:00.000Z",
			saturnProjectId: 42,
			saturnLaidOut: true,
		});
		expect(serialized.scenes).toHaveLength(1);
		expect(serialized.currentSceneId).toBe("scene-1");
		expect(serialized.version).toBe(31);
		expect(serialized.settings).toEqual(project.settings);
	});

	test("dates become ISO strings, so a snapshot survives structured clone", () => {
		const project = buildProject();
		const serialized = serializeProject({
			project,
			duration: project.metadata.duration,
		});

		expect(typeof serialized.scenes[0].createdAt).toBe("string");
		expect(typeof serialized.scenes[0].updatedAt).toBe("string");
		expect(serialized.scenes[0].createdAt).toBe("2024-01-01T00:00:00.000Z");
	});

	test("drops live AudioBuffers, which cannot be stored", () => {
		const tracks = buildSceneTracks({ mainMediaIds: ["media-1"] });
		// A buffer is attached in memory once the file is decoded; it must not
		// reach IndexedDB.
		//
		// The value is irrelevant to what is being tested — `stripAudioBuffers`
		// destructures the key out and never inspects it — so this stands in for
		// the real thing. A genuine `AudioBuffer` cannot be constructed under
		// `bun test` (no Web Audio), which is why a structural stand-in is used
		// rather than the real type.
		const fakeAudioBuffer = { length: 8, sampleRate: 44_100 };
		const withBuffer = {
			...tracks,
			audio: [
				{
					id: "audio",
					name: "Audio",
					type: "audio" as const,
					muted: false,
					elements: [
						{
							id: "a1",
							type: "audio" as const,
							name: "Sound",
							sourceType: "upload" as const,
							mediaId: "media-2",
							startTime: ZERO_MEDIA_TIME,
							duration: mediaTime({ ticks: 10 }),
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							params: {},
							// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the app's AudioBuffer is a DOM type unavailable in this runtime; the value is never read, see above
							buffer: fakeAudioBuffer as unknown as AudioBuffer,
						},
					],
				},
			],
		};
		const stripped = stripAudioBuffers({ tracks: withBuffer });
		const element = stripped.audio[0].elements[0];

		expect("buffer" in element).toBe(false);
		// Everything else survives the strip. Narrowed rather than asserted:
		// `mediaId` only exists on the upload variant of the audio union.
		expect(element.sourceType).toBe("upload");
		if (element.sourceType !== "upload") return;
		expect(element.mediaId).toBe("media-2");
		expect(stripped.main.elements).toHaveLength(1);
	});

	test("omits optional metadata keys instead of writing undefined", () => {
		const serialized = serializeProjectMetadata({
			metadata: {
				id: "project-2",
				name: "无土星项目",
				duration: ZERO_MEDIA_TIME,
				createdAt: new Date("2024-01-01T00:00:00.000Z"),
				updatedAt: new Date("2024-01-01T00:00:00.000Z"),
			},
			duration: ZERO_MEDIA_TIME,
		});

		// An explicit `undefined` would serialize into IndexedDB as null and
		// show up on every locally-created project.
		expect("saturnProjectId" in serialized).toBe(false);
		expect("saturnLaidOut" in serialized).toBe(false);
	});

	test("serializes scenes independently of project metadata", () => {
		const scenes = serializeScenes({
			scenes: [
				buildLiveScene({ id: "scene-1" }),
				buildLiveScene({ id: "scene-2" }),
			],
		});

		expect(scenes.map((scene) => scene.id)).toEqual(["scene-1", "scene-2"]);
	});

	test("picks the main scene as the duration source, falling back to the first", () => {
		const main = buildLiveScene({ id: "main-scene" });
		const other = { ...buildLiveScene({ id: "other" }), isMain: false };

		expect(getDurationSourceScene({ scenes: [other, main] })?.id).toBe(
			"main-scene",
		);
		expect(getDurationSourceScene({ scenes: [other] })?.id).toBe("other");
		expect(getDurationSourceScene({ scenes: [] })).toBeNull();
	});
});
