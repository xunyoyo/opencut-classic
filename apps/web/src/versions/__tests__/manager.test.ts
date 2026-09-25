import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { buildLiveScene, buildSnapshot, tick } from "./fixtures";
import type { TProject } from "@/project/types";
import type { ProjectVersion } from "@/versions/types";
import type { VersionManagerHost } from "@/versions/manager";

/**
 * No wasm stub is installed here: the vendored package is replaced once for the
 * whole suite by `bunfig.toml`'s preload (`src/test/wasm-test-stub.ts`), so the
 * tick math this file relies on is already in place before the first import.
 */

/**
 * The store is replaced with an in-memory double so this file tests the
 * manager's *decisions* — when it snapshots, in what order, what it refuses —
 * rather than re-testing persistence, which `store.test.ts` covers.
 */
const saved: ProjectVersion[] = [];
let loadResult: ProjectVersion | null = null;
const callLog: string[] = [];

mock.module("@/versions/store", () => ({
	listVersions: async () => ({ ok: true, versions: [] }),
	saveVersion: async ({ version }: { version: ProjectVersion }) => {
		callLog.push(`saveVersion:${version.isAuto ? "auto" : "manual"}`);
		saved.push(version);
	},
	loadVersion: async () => {
		callLog.push("loadVersion");
		return loadResult;
	},
	markVersionCurrent: async () => {
		callLog.push("markVersionCurrent");
	},
	deleteVersion: async () => {},
	pruneVersions: async () => 0,
	loadAllVersions: async () => [],
	deleteVersionsForProject: async () => {},
}));

const { VersionManager } = await import("@/versions/manager");

const PROJECT_ID = "project-1";

/**
 * Removes line and block comments so a source-level assertion tests the code
 * rather than the prose around it — the manager's own comments explain the
 * media-clearing hazard by name.
 */
function stripComments({ source }: { source: string }): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function buildActiveProject(): TProject {
	return {
		metadata: {
			id: PROJECT_ID,
			name: "测试项目",
			duration: tick({ value: 500 }),
			createdAt: new Date("2024-01-01T00:00:00.000Z"),
			updatedAt: new Date("2024-01-01T00:00:00.000Z"),
		},
		// Deliberately stale relative to the scenes manager: the manager must
		// read live scenes, exactly as `saveCurrentProject` does.
		scenes: [buildLiveScene({ id: "stale-scene" })],
		currentSceneId: "stale-scene",
		settings: buildSnapshot().settings,
		version: 31,
	};
}

/**
 * Minimal host stand-in: only what `VersionManager` declares it needs.
 *
 * No assertion at the boundary — `VersionManagerHost` exists precisely so that
 * an object literal typed as itself is a valid constructor argument. Passing a
 * full `EditorCore` would mean faking a dozen unrelated managers to test four
 * calls.
 */
function buildEditor({
	liveScenes = [buildLiveScene()],
	hasProject = true,
}: {
	liveScenes?: TProject["scenes"];
	hasProject?: boolean;
} = {}): VersionManagerHost {
	let activeProject: TProject | null = hasProject ? buildActiveProject() : null;

	return {
		project: {
			getActiveOrNull: () => activeProject,
			setActiveProject: ({ project }: { project: TProject }) => {
				callLog.push("setActiveProject");
				activeProject = project;
			},
		},
		scenes: {
			getScenes: () => liveScenes,
			initializeScenes: () => {
				callLog.push("initializeScenes");
			},
		},
		save: {
			flush: async () => {},
			markDirty: () => {
				callLog.push("markDirty");
			},
		},
	};
}

function buildStoredVersion({
	appVersion = 31,
	isAuto = false,
	currentSceneId = "scene-1",
}: {
	appVersion?: number;
	isAuto?: boolean;
	currentSceneId?: string;
} = {}): ProjectVersion {
	return {
		id: "target",
		projectId: PROJECT_ID,
		name: "旧版本",
		createdAt: 1,
		isCurrent: false,
		isAuto,
		appVersion,
		mediaIds: [],
		snapshot: buildSnapshot({ currentSceneId }),
	};
}

beforeEach(() => {
	saved.length = 0;
	callLog.length = 0;
	loadResult = null;
});

describe("saving a version", () => {
	test("names a version when given one and leaves it blank otherwise", async () => {
		const manager = new VersionManager(buildEditor());

		await manager.save({ name: "第一版粗剪" });
		await manager.save({});

		expect(saved[0].name).toBe("第一版粗剪");
		// Blank, not a preformatted timestamp: the row renders the date itself,
		// so an auto-named version stays distinguishable from a typed one.
		expect(saved[1].name).toBe("");
		expect(saved[1].isAuto).toBe(false);
	});

	test("stamps the current app version so a stale snapshot is recognisable", async () => {
		const manager = new VersionManager(buildEditor());

		await manager.save({});

		expect(saved[0].appVersion).toBe(manager.currentAppVersion());
	});

	test("snapshots the live scenes, not the project record's copy", async () => {
		const manager = new VersionManager(
			buildEditor({
				liveScenes: [
					buildLiveScene({ id: "scene-live", mainMediaIds: ["media-9"] }),
				],
			}),
		);

		await manager.save({});

		expect(saved[0].snapshot.scenes.map((scene) => scene.id)).toEqual([
			"scene-live",
		]);
	});

	test("collects the media ids a snapshot depends on", async () => {
		const manager = new VersionManager(
			buildEditor({
				liveScenes: [buildLiveScene({ mainMediaIds: ["media-9", "media-8"] })],
			}),
		);

		await manager.save({});

		expect(saved[0].mediaIds.sort()).toEqual(["media-8", "media-9"]);
	});

	test("returns null when no project is open", async () => {
		const manager = new VersionManager(buildEditor({ hasProject: false }));

		expect(await manager.save({})).toBeNull();
	});
});

describe("applying a version", () => {
	test("snapshots the current state BEFORE overwriting it", async () => {
		loadResult = buildStoredVersion();
		const manager = new VersionManager(buildEditor());

		const result = await manager.apply({ versionId: "target" });

		expect(result.ok).toBe(true);
		// The safety snapshot is what makes restore non-destructive; without it
		// one click would permanently discard the user's unsaved work.
		expect(saved.some((record) => record.isAuto)).toBe(true);
		// And it happened before anything was overwritten.
		expect(callLog.indexOf("saveVersion:auto")).toBeLessThan(
			callLog.indexOf("initializeScenes"),
		);
	});

	test("refuses to restore when the safety snapshot cannot be taken", async () => {
		loadResult = buildStoredVersion();
		// No project open means `save` returns null, so the restore has no undo
		// point and must not proceed.
		const manager = new VersionManager(buildEditor({ hasProject: false }));

		const result = await manager.apply({ versionId: "target" });

		expect(result.ok).toBe(false);
		expect(callLog).not.toContain("initializeScenes");
	});

	test("never clears media assets while restoring", async () => {
		// Asserted against the manager's source, not against the host fake.
		// `VersionManagerHost` deliberately has no `media` member, so a fake-based
		// check could not fail even if the restore path called
		// `media.clearAllAssets()` — it would only prove the fake stayed silent.
		//
		// The real hazard: `loadProject` clears media because it switches
		// projects, and the version store references media by ids that already
		// live in *this* project's OPFS directory. Copying that call here would
		// delete the user's footage from a dialog promising to restore their work.
		const raw = await readFile(
			new URL("../manager.ts", import.meta.url),
			"utf8",
		);
		const code = stripComments({ source: raw });

		expect(code).not.toContain("clearAllAssets");
		expect(code).not.toContain("clearAllData");

		// And the restore still ran, so the assertion above is not vacuous.
		loadResult = buildStoredVersion();
		const manager = new VersionManager(buildEditor());
		const result = await manager.apply({ versionId: "target" });
		expect(result.ok).toBe(true);
		expect(callLog).toContain("initializeScenes");
	});

	test("refuses a snapshot written by a different app version", async () => {
		loadResult = buildStoredVersion({ appVersion: 1 });
		const manager = new VersionManager(buildEditor());

		const result = await manager.apply({ versionId: "target" });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("无法直接恢复");
		// Not even a safety snapshot: the restore did not begin.
		expect(saved).toHaveLength(0);
	});

	test("reports a missing version instead of silently doing nothing", async () => {
		loadResult = null;
		const manager = new VersionManager(buildEditor());

		const result = await manager.apply({ versionId: "gone" });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("已被删除");
	});

	test("warns about library audio whose external URL may have expired", async () => {
		const snapshot = buildSnapshot();
		snapshot.scenes[0].tracks.audio = [
			{
				id: "audio-track",
				name: "Audio",
				type: "audio",
				muted: false,
				elements: [
					{
						id: "a1",
						type: "audio",
						name: "Sound",
						sourceType: "library",
						sourceUrl: "https://cdn.example.com/sound.mp3",
						startTime: tick({ value: 0 }),
						duration: tick({ value: 10 }),
						trimStart: tick({ value: 0 }),
						trimEnd: tick({ value: 0 }),
						params: {},
					},
				],
			},
		];
		loadResult = { ...buildStoredVersion(), snapshot };
		const manager = new VersionManager(buildEditor());

		const result = await manager.apply({ versionId: "target" });

		// Allowed through with a warning, not blocked: refusing would strand the
		// user's actual edit over a sound effect.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.warnings).toHaveLength(1);
	});

	test("restores the scene pointer and marks the restored version current", async () => {
		loadResult = buildStoredVersion({ currentSceneId: "scene-1" });
		const manager = new VersionManager(buildEditor());

		await manager.apply({ versionId: "target" });

		expect(callLog).toContain("initializeScenes");
		expect(callLog).toContain("setActiveProject");
		// The flag follows the restore, so the list marks what the user sees.
		expect(callLog).toContain("markVersionCurrent");
		// And the restored content is flushed, or a reload would look like the
		// restore never happened.
		expect(callLog).toContain("markDirty");
	});

	test("applies a version saved by the current build", async () => {
		loadResult = buildStoredVersion({ appVersion: 31 });
		const manager = new VersionManager(buildEditor());

		const result = await manager.apply({ versionId: "target" });

		expect(result.ok).toBe(true);
	});
});
