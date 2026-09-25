import { describe, expect, test } from "bun:test";
import {
	projectVersionSchema,
	snapshotSchema,
	getUnrecoverableReason,
	hasExternalMediaReference,
	collectMediaIds,
	toSummary,
} from "@/versions/types";
import type { ProjectVersionSummary } from "@/versions/types";
import {
	buildScene,
	buildSceneTracks,
	buildSnapshot,
	buildVersion,
	tick,
} from "./fixtures";

function summary({
	appVersion = 31,
	mediaCount = 0,
}: {
	appVersion?: number;
	mediaCount?: number;
} = {}): ProjectVersionSummary {
	return {
		id: "v1",
		projectId: "project-1",
		name: "",
		createdAt: 1,
		isCurrent: false,
		isAuto: false,
		appVersion,
		mediaCount,
	};
}

describe("version record schema", () => {
	test("accepts a complete record", () => {
		expect(
			projectVersionSchema.safeParse(buildVersion({ id: "v1" })).success,
		).toBe(true);
	});

	test("rejects a record whose scenes are not an array", () => {
		// The shape a truncated or corrupted write produces.
		const result = projectVersionSchema.safeParse({
			...buildVersion({ id: "v1" }),
			snapshot: { scenes: "truncated" },
		});
		expect(result.success).toBe(false);
	});

	test("rejects a record missing required fields", () => {
		const { isCurrent: _dropped, ...incomplete } = buildVersion({ id: "v1" });
		expect(projectVersionSchema.safeParse(incomplete).success).toBe(false);
	});

	test("rejects a record with the wrong type for a flag", () => {
		const result = projectVersionSchema.safeParse({
			...buildVersion({ id: "v1" }),
			isCurrent: "yes",
		});
		expect(result.success).toBe(false);
	});

	test("passes unknown snapshot fields through instead of stripping them", () => {
		// `passthrough` is load-bearing: a plain `z.object` would drop
		// `metadata`/`settings` on parse, and a restore would then silently
		// reset the project's settings and thumbnail.
		const snapshot = buildSnapshot();
		const parsed = snapshotSchema.parse(snapshot);

		expect(parsed.metadata).toEqual(snapshot.metadata);
		expect(parsed.settings).toEqual(snapshot.settings);
		expect(parsed.version).toBe(31);
	});

	test("does not validate inside a scene, which the editor owns", () => {
		// Snapshot shape changes with CURRENT_PROJECT_VERSION; duplicating the
		// full schema here would reject tomorrow's snapshot. `appVersion` gates
		// applicability instead.
		const snapshot = {
			scenes: [{ totally: "different", future: 1 }],
			currentSceneId: "x",
		};
		const result = projectVersionSchema.safeParse({
			...buildVersion({ id: "v1" }),
			snapshot,
		});
		expect(result.success).toBe(true);
	});
});

describe("applicability", () => {
	test("allows a version saved by the current app version", () => {
		expect(
			getUnrecoverableReason({
				version: summary({ appVersion: 31 }),
				currentAppVersion: 31,
			}),
		).toBeNull();
	});

	test("explains why a version from an older build cannot be restored", () => {
		const reason = getUnrecoverableReason({
			version: summary({ appVersion: 12 }),
			currentAppVersion: 31,
		});

		expect(reason).toContain("v12");
		expect(reason).toContain("v31");
	});
});

describe("media references", () => {
	test("collects every media id an element points at", () => {
		const snapshot = buildSnapshot({
			scenes: [
				buildScene({
					tracks: buildSceneTracks({
						mainMediaIds: ["media-1", "media-2", "media-1"],
					}),
				}),
			],
		});

		expect(collectMediaIds({ snapshot }).sort()).toEqual([
			"media-1",
			"media-2",
		]);
	});

	test("collects media ids from overlay and audio tracks too", () => {
		const snapshot = buildSnapshot();
		const scene = snapshot.scenes[0];
		scene.tracks.overlay = [
			{
				id: "o1",
				name: "Overlay",
				type: "video",
				muted: false,
				hidden: false,
				elements: [
					{
						id: "e4",
						type: "image",
						name: "Image",
						mediaId: "overlay-media",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 1 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];
		scene.tracks.audio = [
			{
				id: "a1",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "e5",
						type: "audio",
						name: "Sound",
						sourceType: "upload",
						mediaId: "audio-media",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 1 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];

		expect(collectMediaIds({ snapshot }).sort()).toEqual([
			"audio-media",
			"overlay-media",
		]);
	});

	test("ignores a library audio element, which has no media id", () => {
		const snapshot = buildSnapshot();
		snapshot.scenes[0].tracks.audio = [
			{
				id: "a1",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "e1",
						type: "audio",
						name: "Sound",
						sourceType: "library",
						sourceUrl: "https://cdn.example.com/x.mp3",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 1 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];

		expect(collectMediaIds({ snapshot })).toEqual([]);
	});

	test("flags a library audio element as an external reference", () => {
		const snapshot = buildSnapshot();
		snapshot.scenes[0].tracks.audio = [
			{
				id: "a1",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "e1",
						type: "audio",
						name: "Sound",
						sourceType: "library",
						sourceUrl: "https://cdn.example.com/x.mp3",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 1 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];

		expect(hasExternalMediaReference({ snapshot })).toBe(true);
	});

	test("does not flag an uploaded audio element, which lives in OPFS", () => {
		const snapshot = buildSnapshot();
		snapshot.scenes[0].tracks.audio = [
			{
				id: "a1",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "e1",
						type: "audio",
						name: "Sound",
						sourceType: "upload",
						mediaId: "media-1",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 1 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];

		expect(hasExternalMediaReference({ snapshot })).toBe(false);
	});

	test("survives a malformed snapshot instead of throwing during render", () => {
		// A record written by an older build may not have the track shape this
		// build expects; the walk has to degrade, not crash the panel. These
		// callers take `unknown` precisely so no assertion is needed here.
		const broken = {
			metadata: {},
			scenes: [{ id: "s1", tracks: null }, null, "not-a-scene"],
			currentSceneId: "",
			settings: {},
			version: 31,
		};

		expect(() => collectMediaIds({ snapshot: broken })).not.toThrow();
		expect(collectMediaIds({ snapshot: broken })).toEqual([]);
		expect(() => hasExternalMediaReference({ snapshot: broken })).not.toThrow();
		expect(hasExternalMediaReference({ snapshot: broken })).toBe(false);
	});

	test("treats a snapshot with no scenes field as having no media", () => {
		expect(collectMediaIds({ snapshot: {} })).toEqual([]);
		expect(collectMediaIds({ snapshot: null })).toEqual([]);
	});
});

describe("summaries", () => {
	test("drops the snapshot and reports the media count", () => {
		const result = toSummary({
			version: buildVersion({ id: "v1", mediaIds: ["a", "b"] }),
		});

		expect("snapshot" in result).toBe(false);
		expect(result.mediaCount).toBe(2);
		expect(result.id).toBe("v1");
	});
});
