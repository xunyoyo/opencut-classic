import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import { RemoveMediaAssetCommand } from "@/commands/media/remove-media-asset";
import { BatchCommand } from "@/commands/batch-command";
import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";
import { MediaManager } from "@/core/managers/media-manager";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import type { SceneTracks } from "@/timeline";
import {
	flushStorageWork,
	installFakeMediaStorage,
	mediaMetadata,
} from "@/services/storage/__tests__/fake-media-storage";

const PROJECT_ID = "project-1";

/**
 * Stands in for the object URL registry so a test can tell a live URL from a
 * revoked one, and see which blob a URL was minted from.
 */
function stubObjectUrls() {
	const live = new Set<string>();
	const sources = new Map<string, unknown>();
	spyOn(URL, "createObjectURL").mockImplementation((object: unknown) => {
		const url = `blob:minted-${sources.size + 1}`;
		sources.set(url, object);
		live.add(url);
		return url;
	});
	spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
		live.delete(url);
	});
	return {
		/** Registers a URL an asset was given before the test started. */
		adopt: (url: string) => {
			live.add(url);
		},
		isLive: (url: string | undefined) => url !== undefined && live.has(url),
		/** MIME type of the blob `url` was minted from. */
		typeOf: (url: string | undefined) => {
			const source = sources.get(url ?? "");
			return source instanceof Blob ? source.type : undefined;
		},
	};
}

/** Narrows away `null`/`undefined`, failing the test instead of asserting. */
function present<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("Expected a value");
	}
	return value;
}

type ObjectUrls = ReturnType<typeof stubObjectUrls>;

function stubStorage() {
	return {
		deleteMetadata: spyOn(
			storageService,
			"deleteMediaAssetMetadata",
		).mockImplementation(async () => {}),
		restore: spyOn(storageService, "restoreMediaAsset").mockImplementation(
			async () => {},
		),
		deleteOrphan: spyOn(
			storageService,
			"deleteOrphanedMediaFile",
		).mockImplementation(async () => {}),
		save: spyOn(storageService, "saveMediaAsset").mockImplementation(
			async () => {},
		),
		deleteAsset: spyOn(storageService, "deleteMediaAsset").mockImplementation(
			async () => {},
		),
		// No stored copy to read back unless a test provides one, so imports
		// keep the file they came with.
		load: spyOn(storageService, "loadMediaAsset").mockImplementation(
			async () => null,
		),
	};
}

function emptyTracks(): SceneTracks {
	return {
		overlay: [],
		main: { id: "main", elements: [] },
		audio: [],
	} as unknown as SceneTracks;
}

/**
 * The commands reach the editor through the `EditorCore` singleton, so a stub
 * is installed in its place. The media list and the command history are the
 * real managers: the list's behaviour across undo/redo is what is under test.
 */
function createEditor({ assets }: { assets: MediaAsset[] }) {
	let tracks = emptyTracks();
	const editor: Record<string, unknown> = {
		project: {
			getActiveOrNull: () => null,
			ratchetFpsForImportedMedia: () => null,
		},
		scenes: {
			getActiveScene: () => ({ tracks }),
			getActiveSceneOrNull: () => ({ tracks }),
		},
		timeline: {
			deleteElements: () => {},
			updateTracks: (next: SceneTracks) => {
				tracks = next;
			},
		},
		selection: {
			getSnapshot: () => ({}),
			restoreSnapshot: () => {},
		},
	};
	const media = new MediaManager(editor as unknown as EditorCore);
	const command = new CommandManager(editor as unknown as EditorCore);
	Object.assign(editor, { media, command });
	Object.assign(EditorCore, { instance: editor });
	media.setAssets({ assets });
	return { media, command };
}

function libraryAsset({
	id,
	urls,
}: {
	id: string;
	urls: ObjectUrls;
}): MediaAsset {
	const url = `blob:${id}`;
	urls.adopt(url);
	return {
		id,
		name: `${id}.mp4`,
		type: "video",
		file: new File([new Uint8Array(4)], `${id}.mp4`),
		url,
	};
}

/** A file as it arrives from a download, a drop or a paste: on the heap. */
function incomingAsset({
	name,
	urls,
}: {
	name: string;
	urls: ObjectUrls;
}): Omit<MediaAsset, "id"> {
	const url = `blob:${name}-heap`;
	urls.adopt(url);
	return {
		name,
		type: "video",
		file: new File([new Uint8Array(4)], name, { type: "video/mp4" }),
		url,
	};
}

function remove(assetId: string) {
	return new RemoveMediaAssetCommand({ projectId: PROJECT_ID, assetId });
}

function ids(media: MediaManager): string[] {
	return media.getAssets().map((asset) => asset.id);
}

function expectAllUrlsLive({
	media,
	urls,
}: {
	media: MediaManager;
	urls: ObjectUrls;
}) {
	for (const asset of media.getAssets()) {
		expect({ id: asset.id, live: urls.isLive(asset.url) }).toEqual({
			id: asset.id,
			live: true,
		});
	}
}

class NoopCommand extends Command {
	execute(): CommandResult | undefined {
		return undefined;
	}

	undo(): void {}
}

afterEach(() => {
	mock.restore();
	EditorCore.reset();
});

describe("RemoveMediaAssetCommand undo/redo", () => {
	test("undoing a batch removal puts every asset back with a live URL", () => {
		const urls = stubObjectUrls();
		stubStorage();
		const { media, command } = createEditor({
			assets: ["a", "b", "c"].map((id) => libraryAsset({ id, urls })),
		});

		command.execute({ command: new BatchCommand([remove("a"), remove("b")]) });
		expect(ids(media)).toEqual(["c"]);
		expect(urls.isLive("blob:a")).toBe(false);
		expect(urls.isLive("blob:b")).toBe(false);

		command.undo();

		expect(ids(media)).toEqual(["a", "b", "c"]);
		expectAllUrlsLive({ media, urls });
	});

	test("undoing a removal keeps assets imported after it", async () => {
		const urls = stubObjectUrls();
		stubStorage();
		const { media, command } = createEditor({
			assets: ["a", "b"].map((id) => libraryAsset({ id, urls })),
		});

		command.execute({ command: remove("a") });
		const imported = await media.addMediaAsset({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "later.mp4", urls }),
		});

		command.undo();

		expect(ids(media)).toEqual(["a", "b", present(imported).id]);
		expectAllUrlsLive({ media, urls });
	});

	test("undoing a removal made during a background import keeps the import's work", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { media, command } = createEditor({
			assets: ["a", "b"].map((id) => libraryAsset({ id, urls })),
		});

		// The import's save is held until the removal has run.
		let finishSave: () => void = () => {};
		storage.save.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				}),
		);
		const storedFiles = new Map<string, File>();
		storage.load.mockImplementation(async ({ id }) => {
			const file = new File([new Uint8Array(4)], `stored-${id}`);
			storedFiles.set(id, file);
			return {
				id,
				name: `${id}.mp4`,
				type: "video",
				file,
				url: URL.createObjectURL(file),
			};
		});

		const importing = media.addMediaAsset({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "shot.mp4", urls }),
		});
		command.execute({ command: remove("b") });

		finishSave();
		const shot = await importing;
		storage.save.mockImplementation(async () => {});
		const nextShot = await media.addMediaAsset({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "next-shot.mp4", urls }),
		});
		const shotId = present(shot).id;
		const nextShotId = present(nextShot).id;

		command.undo();

		expect(ids(media)).toEqual(["a", "b", shotId, nextShotId]);
		// Still on the stored file the import swapped in, not the heap copy
		// (whose URL the import has revoked).
		const heldShot = media.getAssets().find((asset) => asset.id === shotId);
		expect(heldShot?.file).toBe(present(storedFiles.get(shotId)));
		expectAllUrlsLive({ media, urls });
	});

	test("removing an asset while it is still saving leaves no record behind", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { media, command } = createEditor({ assets: [] });

		const order: string[] = [];
		let finishSave: () => void = () => {};
		storage.save.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSave = () => {
						order.push("save");
						resolve();
					};
				}),
		);
		storage.deleteMetadata.mockImplementation(async () => {
			order.push("delete-metadata");
		});

		const importing = media.addMediaAsset({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "shot.mp4", urls }),
		});
		const shotId = present(media.getAssets()[0]).id;
		command.execute({ command: remove(shotId) });
		await Promise.resolve();

		// The delete must not overtake the save's record write.
		expect(order).toEqual([]);
		finishSave();
		await importing;
		await flushStorageWork();

		expect(order).toEqual(["save", "delete-metadata"]);
		expect(ids(media)).toEqual([]);
	});

	test("redo takes out only that asset again", async () => {
		const urls = stubObjectUrls();
		stubStorage();
		const { media, command } = createEditor({
			assets: ["a", "b", "c"].map((id) => libraryAsset({ id, urls })),
		});
		command.execute({ command: remove("b") });
		command.undo();
		const restoredUrl = media.getAssets()[1].url;
		const imported = await media.addMediaAsset({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "later.mp4", urls }),
		});

		command.redo();

		expect(ids(media)).toEqual(["a", "c", present(imported).id]);
		expect(urls.isLive(restoredUrl)).toBe(false);
		expectAllUrlsLive({ media, urls });
	});

	test("undoing the removal of a stored SVG gives it a URL typed as SVG", async () => {
		const urls = stubObjectUrls();
		// Read through the real `loadMediaAsset`, from a stored file that has
		// no type, the way OPFS hands it back.
		installFakeMediaStorage({
			service: storageService,
			files: {
				logo: new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "logo"),
			},
			metadata: { logo: mediaMetadata({ id: "logo", type: "image" }) },
		});
		const loaded = await storageService.loadMediaAsset({
			projectId: PROJECT_ID,
			id: "logo",
		});
		stubStorage();
		const { media, command } = createEditor({
			assets: [present(loaded)],
		});

		command.execute({ command: remove("logo") });
		command.undo();

		const [restored] = media.getAssets();
		expect(restored.url).not.toBe(loaded?.url);
		expect(urls.isLive(restored.url)).toBe(true);
		expect(urls.typeOf(restored.url)).toBe("image/svg+xml");
	});

	test("an undo right after the removal writes its record after the removal's delete", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const calls: string[] = [];
		let finishDelete: () => void = () => {};
		storage.deleteMetadata.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishDelete = () => {
						calls.push("delete");
						resolve();
					};
				}),
		);
		storage.restore.mockImplementation(async () => {
			calls.push("restore");
		});
		const { command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});

		command.execute({ command: remove("a") });
		command.undo();
		await flushStorageWork();
		expect(calls).toEqual([]);

		finishDelete();
		await flushStorageWork();

		expect(calls).toEqual(["delete", "restore"]);
	});
});

describe("RemoveMediaAssetCommand stored bytes", () => {
	test("are kept while the removal can still be undone", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});

		command.execute({ command: remove("a") });
		for (let i = 0; i < 99; i += 1) {
			command.execute({ command: new NoopCommand() });
		}
		await flushStorageWork();

		expect(storage.deleteOrphan).not.toHaveBeenCalled();
	});

	test("are deleted once the removal is trimmed off the history", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});

		command.execute({ command: remove("a") });
		for (let i = 0; i < 100; i += 1) {
			command.execute({ command: new NoopCommand() });
		}
		await flushStorageWork();

		expect(storage.deleteOrphan).toHaveBeenCalledTimes(1);
		expect(storage.deleteOrphan).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			id: "a",
		});
	});

	test("are deleted for every removal of a batch when the history is cleared", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { command } = createEditor({
			assets: ["a", "b"].map((id) => libraryAsset({ id, urls })),
		});

		command.execute({ command: new BatchCommand([remove("a"), remove("b")]) });
		command.clear();
		await flushStorageWork();

		expect(
			storage.deleteOrphan.mock.calls.map(([args]) => args.id).sort(),
		).toEqual(["a", "b"]);
	});

	test("are kept when the removal was undone before it was dropped", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});

		command.execute({ command: remove("a") });
		command.undo();
		// Drops the undone removal with the redo stack.
		command.execute({ command: new NoopCommand() });
		command.clear();
		await flushStorageWork();

		expect(storage.deleteOrphan).not.toHaveBeenCalled();
	});

	test("are deleted only after the removal's metadata delete has landed", async () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		let finishDelete: () => void = () => {};
		storage.deleteMetadata.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishDelete = resolve;
				}),
		);
		const { command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});

		command.execute({ command: remove("a") });
		command.clear();
		await flushStorageWork();
		expect(storage.deleteOrphan).not.toHaveBeenCalled();

		finishDelete();
		await flushStorageWork();

		expect(storage.deleteOrphan).toHaveBeenCalledTimes(1);
	});
});

describe("AddMediaAssetCommand undo/redo", () => {
	test("undo takes out only that asset and gives its URL back", () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { media, command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});
		const pasted = incomingAsset({ name: "pasted.mp4", urls });
		const add = new AddMediaAssetCommand({
			projectId: PROJECT_ID,
			asset: pasted,
		});

		command.execute({ command: add });
		media.setAssets({
			assets: [...media.getAssets(), libraryAsset({ id: "later", urls })],
		});

		command.undo();

		expect(ids(media)).toEqual(["a", "later"]);
		expect(urls.isLive(pasted.url)).toBe(false);
		expect(storage.deleteAsset).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			id: add.getAssetId(),
		});
		expectAllUrlsLive({ media, urls });
	});

	test("redo puts it back where it was with a fresh URL", () => {
		const urls = stubObjectUrls();
		const storage = stubStorage();
		const { media, command } = createEditor({
			assets: [libraryAsset({ id: "a", urls })],
		});
		const add = new AddMediaAssetCommand({
			projectId: PROJECT_ID,
			asset: incomingAsset({ name: "pasted.mp4", urls }),
		});
		command.execute({ command: add });
		media.setAssets({
			assets: [...media.getAssets(), libraryAsset({ id: "later", urls })],
		});
		command.undo();

		command.redo();

		expect(ids(media)).toEqual(["a", add.getAssetId(), "later"]);
		expectAllUrlsLive({ media, urls });
		expect(storage.save).toHaveBeenCalledTimes(2);
	});
});
