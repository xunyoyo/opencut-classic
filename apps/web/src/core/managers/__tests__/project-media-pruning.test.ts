import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { MediaManager } from "@/core/managers/media-manager";
import { ProjectManager } from "@/core/managers/project-manager";
import type { TProject } from "@/project/types";
import { ORPHANED_MEDIA_FILE_MIN_AGE_MS } from "@/services/storage/media-orphans";
import { storageService } from "@/services/storage/service";
import {
	flushStorageWork,
	installFakeMediaStorage,
	mediaMetadata,
} from "@/services/storage/__tests__/fake-media-storage";

/**
 * Orphaned media bytes include those of removals that can still be undone,
 * so only opening a project — which clears the undo history first — may
 * prune them. These cover the callers on either side of that line.
 */

const OLD = Date.now() - ORPHANED_MEDIA_FILE_MIN_AGE_MS - 60_000;

function buildProject({ id }: { id: string }): TProject {
	return {
		metadata: {
			id,
			name: "项目",
			// Present so opening it does not try to render a new one.
			thumbnail: "data:image/jpeg;base64,",
			duration: 0,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		scenes: [],
		currentSceneId: "",
		settings: {},
		version: 1,
	} as unknown as TProject;
}

afterEach(() => {
	mock.restore();
});

describe("duplicating a project", () => {
	test("leaves the source project's orphaned bytes alone", async () => {
		// The source may be the project open in the editor, whose orphaned
		// bytes are what its undo history needs to put removed assets back.
		const storage = installFakeMediaStorage({
			service: storageService,
			files: {
				kept: new File([new Uint8Array(4)], "kept", { lastModified: OLD }),
				"removed-but-undoable": new File([new Uint8Array(4)], "removed", {
					lastModified: OLD,
				}),
			},
			metadata: { kept: mediaMetadata({ id: "kept" }) },
		});
		spyOn(storageService, "loadProject").mockImplementation(async ({ id }) => ({
			project: buildProject({ id }),
		}));
		spyOn(storageService, "saveProject").mockImplementation(async () => {});
		const copied = spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => {},
		);
		spyOn(URL, "createObjectURL").mockImplementation(() => "blob:copy");
		const manager = new ProjectManager({} as EditorCore);

		await manager.duplicateProjects({ ids: ["source"] });
		await flushStorageWork();

		expect(copied.mock.calls.map(([args]) => args.mediaAsset.id)).toEqual([
			"kept",
		]);
		expect(storage.removedFiles).toEqual([]);
	});
});

describe("opening a project", () => {
	test("prunes orphaned bytes, and only after clearing the history", async () => {
		const calls: string[] = [];
		const editor = {
			save: { pause: () => {}, resume: () => {} },
			media: {
				clearAllAssets: () => calls.push("media.clearAllAssets"),
				loadProjectMedia: async ({
					pruneOrphanedFiles,
				}: {
					pruneOrphanedFiles?: boolean;
				}) => {
					calls.push(`media.loadProjectMedia prune=${pruneOrphanedFiles}`);
				},
			},
			scenes: { clearScenes: () => {}, initializeScenes: () => {} },
			command: { clear: () => calls.push("command.clear") },
		};
		spyOn(storageService, "loadProject").mockImplementation(async ({ id }) => ({
			project: buildProject({ id }),
		}));
		const manager = new ProjectManager(editor as unknown as EditorCore);
		// The storage migrations need IndexedDB; they are not what is tested.
		Object.assign(manager, { storageMigrationPromise: Promise.resolve() });

		await manager.loadProject({ id: "project-1" });

		expect(calls).toEqual([
			"media.clearAllAssets",
			"command.clear",
			"media.loadProjectMedia prune=true",
		]);
	});

	test("MediaManager passes the prune request through, and defaults to none", async () => {
		const loadAll = spyOn(
			storageService,
			"loadAllMediaAssets",
		).mockImplementation(async () => []);
		const media = new MediaManager({} as EditorCore);

		await media.loadProjectMedia({ projectId: "p" });
		await media.loadProjectMedia({ projectId: "p", pruneOrphanedFiles: true });

		expect(loadAll.mock.calls.map(([args]) => args)).toEqual([
			{ projectId: "p", pruneOrphanedFiles: false },
			{ projectId: "p", pruneOrphanedFiles: true },
		]);
	});
});
