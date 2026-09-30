import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { restoreStoredMediaFileType } from "@/services/storage/media-file-type";
import { ORPHANED_MEDIA_FILE_MIN_AGE_MS } from "@/services/storage/media-orphans";
import { StorageService } from "@/services/storage/service";
import {
	flushStorageWork,
	installFakeMediaStorage,
	mediaMetadata,
} from "./fake-media-storage";

const PROJECT_ID = "project-1";
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
/** Old enough that pruning treats a file without a record as abandoned. */
const OLD = Date.now() - ORPHANED_MEDIA_FILE_MIN_AGE_MS - 60_000;

/** What `FileSystemFileHandle.getFile()` hands back: no MIME type. */
function storedFile({
	name,
	contents = [new Uint8Array(4)],
	lastModified = OLD,
}: {
	name: string;
	contents?: BlobPart[];
	lastModified?: number;
}): File {
	return new File(contents, name, { lastModified });
}

function stubObjectUrls() {
	const sources = new Map<string, unknown>();
	spyOn(URL, "createObjectURL").mockImplementation((object: unknown) => {
		const url = `blob:minted-${sources.size + 1}`;
		sources.set(url, object);
		return url;
	});
	spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	return {
		/** MIME type of the blob `url` was minted from. */
		typeOf: (url: string | undefined) => {
			const source = sources.get(url ?? "");
			return source instanceof Blob ? source.type : undefined;
		},
	};
}

afterEach(() => {
	mock.restore();
});

describe("restoreStoredMediaFileType", () => {
	test("types an untyped SVG image as image/svg+xml", async () => {
		const file = storedFile({ name: "logo", contents: [`\n  ${SVG_TEXT}`] });

		const typed = await restoreStoredMediaFileType({ file, type: "image" });

		expect(typed.type).toBe("image/svg+xml");
		expect(await typed.text()).toBe(await file.text());
		expect(typed.lastModified).toBe(file.lastModified);
	});

	test.each([
		["an XML declaration", `<?xml version="1.0" encoding="UTF-8"?>\n${SVG_TEXT}`],
		["a generator comment", `<!-- Generator: Adobe Illustrator 27.0 -->\n${SVG_TEXT}`],
		[
			"a DOCTYPE",
			`<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n${SVG_TEXT}`,
		],
		["a byte-order mark", `\uFEFF${SVG_TEXT}`],
		["a prologue longer than the sniffed head", `<!-- ${"licence ".repeat(1000)} -->\n${SVG_TEXT}`],
	])("types an SVG that starts with %s", async (_, text) => {
		const file = storedFile({ name: "logo", contents: [text] });

		const typed = await restoreStoredMediaFileType({ file, type: "image" });

		expect(typed.type).toBe("image/svg+xml");
		expect(await typed.text()).toBe(await file.text());
	});

	test("does not read a whole raster image to tell it from an SVG", async () => {
		const png = storedFile({
			name: "photo",
			contents: [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])],
		});
		const read = spyOn(png, "text");

		expect(await restoreStoredMediaFileType({ file: png, type: "image" })).toBe(
			png,
		);
		expect(read).not.toHaveBeenCalled();
	});

	test("leaves untyped raster images, typed files and non-images as they are", async () => {
		const png = storedFile({ name: "photo" });
		const typedSvg = new File([SVG_TEXT], "logo.svg", {
			type: "image/svg+xml",
		});
		const video = storedFile({ name: "clip", contents: [SVG_TEXT] });

		for (const [file, type] of [
			[png, "image"],
			[typedSvg, "image"],
			[video, "video"],
		] as const) {
			expect(await restoreStoredMediaFileType({ file, type })).toBe(file);
		}
	});
});

describe("StorageService.loadMediaAsset", () => {
	test("hands back an SVG whose file and URL are both typed", async () => {
		const service = new StorageService();
		installFakeMediaStorage({
			service,
			files: { logo: storedFile({ name: "logo", contents: [SVG_TEXT] }) },
			metadata: { logo: mediaMetadata({ id: "logo", type: "image" }) },
		});
		const urls = stubObjectUrls();

		const asset = await service.loadMediaAsset({
			projectId: PROJECT_ID,
			id: "logo",
		});

		expect(asset?.file.type).toBe("image/svg+xml");
		expect(urls.typeOf(asset?.url)).toBe("image/svg+xml");
	});
});

describe("StorageService.loadAllMediaAssets", () => {
	function setUp() {
		const service = new StorageService();
		const storage = installFakeMediaStorage({
			service,
			files: {
				kept: storedFile({ name: "kept" }),
				orphan: storedFile({ name: "orphan" }),
			},
			metadata: { kept: mediaMetadata({ id: "kept" }) },
		});
		stubObjectUrls();
		return { service, storage };
	}

	test("leaves orphaned bytes alone by default", async () => {
		const { service, storage } = setUp();

		const assets = await service.loadAllMediaAssets({ projectId: PROJECT_ID });
		await flushStorageWork();

		expect(assets.map((asset) => asset.id)).toEqual(["kept"]);
		expect(storage.removedFiles).toEqual([]);
	});

	test("prunes orphaned bytes only when asked to", async () => {
		const { service, storage } = setUp();

		await service.loadAllMediaAssets({
			projectId: PROJECT_ID,
			pruneOrphanedFiles: true,
		});
		await flushStorageWork();

		expect(storage.removedFiles).toEqual(["orphan"]);
		expect(storage.fileStore.has("kept")).toBe(true);
	});

	test("does not prune the bytes of a save that is still in flight", async () => {
		const { service, storage } = setUp();
		storage.holdMetadataWrites();
		const saving = service.saveMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: {
				id: "saving",
				name: "saving.mp4",
				type: "video",
				// Old on purpose: only the in-flight check can keep it.
				file: storedFile({ name: "saving" }),
			},
		});
		await flushStorageWork();
		expect(storage.fileStore.has("saving")).toBe(true);

		await service.loadAllMediaAssets({
			projectId: PROJECT_ID,
			pruneOrphanedFiles: true,
		});
		await flushStorageWork();

		expect(storage.removedFiles).toEqual(["orphan"]);
		storage.releaseMetadataWrites();
		await saving;
		expect(storage.fileStore.has("saving")).toBe(true);
	});
});

describe("StorageService.deleteOrphanedMediaFile", () => {
	test("deletes bytes no metadata record points at", async () => {
		const service = new StorageService();
		const storage = installFakeMediaStorage({
			service,
			files: { removed: storedFile({ name: "removed" }) },
		});

		await service.deleteOrphanedMediaFile({
			projectId: PROJECT_ID,
			id: "removed",
		});

		expect(storage.removedFiles).toEqual(["removed"]);
	});

	test("keeps bytes a metadata record points at again", async () => {
		const service = new StorageService();
		const storage = installFakeMediaStorage({
			service,
			files: { restored: storedFile({ name: "restored" }) },
			metadata: { restored: mediaMetadata({ id: "restored" }) },
		});

		await service.deleteOrphanedMediaFile({
			projectId: PROJECT_ID,
			id: "restored",
		});

		expect(storage.removedFiles).toEqual([]);
	});

	test("keeps bytes that are still being saved", async () => {
		const service = new StorageService();
		const storage = installFakeMediaStorage({ service });
		storage.holdMetadataWrites();
		const saving = service.saveMediaAsset({
			projectId: PROJECT_ID,
			mediaAsset: {
				id: "saving",
				name: "saving.mp4",
				type: "video",
				file: storedFile({ name: "saving" }),
			},
		});
		await flushStorageWork();

		await service.deleteOrphanedMediaFile({
			projectId: PROJECT_ID,
			id: "saving",
		});

		expect(storage.removedFiles).toEqual([]);
		storage.releaseMetadataWrites();
		await saving;
		expect(storage.fileStore.has("saving")).toBe(true);
	});
});
