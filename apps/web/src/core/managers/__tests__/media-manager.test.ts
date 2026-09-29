import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EditorCore } from "@/core";
import { MediaManager } from "@/core/managers/media-manager";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";

const PROJECT_ID = "project-1";

/**
 * `addMediaAsset` reaches `EditorCore` only to ratchet the project fps, so a
 * one-method stub stands in for the editor rather than the real singleton.
 */
function createManager() {
	const ratcheted: Array<Pick<MediaAsset, "type" | "fps">> = [];
	const editor = {
		project: {
			ratchetFpsForImportedMedia: ({
				importedAssets,
			}: {
				importedAssets: Array<Pick<MediaAsset, "type" | "fps">>;
			}) => {
				ratcheted.push(...importedAssets);
				return null;
			},
		},
	} as unknown as EditorCore;
	return { manager: new MediaManager(editor), ratcheted };
}

function importedAsset(): Omit<MediaAsset, "id"> {
	return {
		name: "shot-1.mp4",
		type: "video",
		file: new File([new Uint8Array(16)], "shot-1.mp4", { type: "video/mp4" }),
		url: "blob:imported",
		duration: 3,
		fps: 25,
	};
}

/** Stands in for the handle `FileSystemFileHandle.getFile()` returns. */
const storedFile = new File([new Uint8Array(16)], "stored");

function stubStorage({
	readBack,
}: {
	readBack: (id: string) => Promise<MediaAsset | null>;
}) {
	const save = spyOn(storageService, "saveMediaAsset").mockImplementation(
		async () => {},
	);
	const load = spyOn(storageService, "loadMediaAsset").mockImplementation(
		async ({ id }) => readBack(id),
	);
	return { save, load };
}

function storedAsset(id: string): MediaAsset {
	return {
		id,
		name: "shot-1.mp4",
		type: "video",
		file: storedFile,
		url: "blob:stored",
	};
}

afterEach(() => {
	mock.restore();
});

describe("MediaManager.addMediaAsset", () => {
	test("replaces the imported file and URL with the stored ones once saved", async () => {
		stubStorage({ readBack: async (id) => storedAsset(id) });
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const clearVideo = spyOn(videoCache, "clearVideo");
		const { manager, ratcheted } = createManager();

		const created = await manager.addMediaAsset({
			projectId: PROJECT_ID,
			asset: importedAsset(),
		});

		expect(created?.file).toBe(storedFile);
		expect(created?.url).toBe("blob:stored");
		// Everything but the bytes is carried over from the imported asset.
		expect(created?.duration).toBe(3);
		expect(created?.fps).toBe(25);

		const [held] = manager.getAssets();
		expect(held.file).toBe(storedFile);
		expect(held.url).toBe("blob:stored");

		expect(revoke).toHaveBeenCalledWith("blob:imported");
		expect(clearVideo).toHaveBeenCalledWith({ mediaId: created?.id });
		expect(ratcheted).toEqual([created as MediaAsset]);
	});

	test("keeps the imported file when the stored copy cannot be read back", async () => {
		stubStorage({ readBack: async () => null });
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const { manager } = createManager();
		const asset = importedAsset();

		const created = await manager.addMediaAsset({
			projectId: PROJECT_ID,
			asset,
		});

		expect(created?.file).toBe(asset.file);
		expect(created?.url).toBe("blob:imported");
		expect(manager.getAssets()[0].file).toBe(asset.file);
		expect(revoke).not.toHaveBeenCalled();
	});

	test("keeps the imported file when reading back throws", async () => {
		stubStorage({
			readBack: async () => {
				throw new Error("NotReadableError");
			},
		});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const { manager } = createManager();
		const asset = importedAsset();

		const created = await manager.addMediaAsset({
			projectId: PROJECT_ID,
			asset,
		});

		expect(created?.file).toBe(asset.file);
		expect(manager.getAssets()).toHaveLength(1);
		expect(warn).toHaveBeenCalled();
	});

	test("does not resurrect an asset removed while it was being saved", async () => {
		const { manager } = createManager();
		spyOn(storageService, "saveMediaAsset").mockImplementation(async () => {
			manager.setAssets({ assets: [] });
		});
		spyOn(storageService, "loadMediaAsset").mockImplementation(async ({ id }) =>
			storedAsset(id),
		);
		const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

		await manager.addMediaAsset({
			projectId: PROJECT_ID,
			asset: importedAsset(),
		});

		expect(manager.getAssets()).toEqual([]);
		// The URL minted for the read-back copy has no owner; it must not leak.
		expect(revoke).toHaveBeenCalledWith("blob:stored");
	});

	test("drops the asset and returns null when the save fails", async () => {
		spyOn(storageService, "saveMediaAsset").mockImplementation(async () => {
			throw new Error("disk full");
		});
		const load = spyOn(storageService, "loadMediaAsset");
		spyOn(console, "error").mockImplementation(() => {});
		const { manager } = createManager();

		const created = await manager.addMediaAsset({
			projectId: PROJECT_ID,
			asset: importedAsset(),
		});

		expect(created).toBeNull();
		expect(manager.getAssets()).toEqual([]);
		expect(load).not.toHaveBeenCalled();
	});
});
