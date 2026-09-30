import { spyOn } from "bun:test";
import type { StorageService } from "@/services/storage/service";
import type { MediaAssetData } from "@/services/storage/types";

/**
 * In-memory stand-ins for one project's OPFS directory and metadata store,
 * swapped into `service` in place of the real adapters (which need a browser).
 * Every project id resolves to the same pair, which is all these tests need.
 *
 * `holdMetadataWrites` parks metadata writes until `releaseMetadataWrites`,
 * to catch a save between writing its bytes and writing its record.
 */
export function installFakeMediaStorage({
	service,
	files = {},
	metadata = {},
}: {
	service: StorageService;
	files?: Record<string, File>;
	metadata?: Record<string, MediaAssetData>;
}) {
	const fileStore = new Map<string, File>(Object.entries(files));
	const metadataStore = new Map<string, MediaAssetData>(
		Object.entries(metadata),
	);
	const removedFiles: string[] = [];
	let heldMetadataWrites: Array<() => void> | null = null;

	const mediaAssetsAdapter = {
		get: async (key: string) => fileStore.get(key) ?? null,
		set: async ({ key, value }: { key: string; value: File }) => {
			fileStore.set(key, value);
		},
		remove: async (key: string) => {
			removedFiles.push(key);
			fileStore.delete(key);
		},
		list: async () => [...fileStore.keys()],
		clear: async () => {
			fileStore.clear();
		},
	};

	const mediaMetadataAdapter = {
		get: async (key: string) => metadataStore.get(key) ?? null,
		set: async ({ key, value }: { key: string; value: MediaAssetData }) => {
			if (heldMetadataWrites) {
				await new Promise<void>((resolve) => heldMetadataWrites?.push(resolve));
			}
			metadataStore.set(key, value);
		},
		remove: async (key: string) => {
			metadataStore.delete(key);
		},
		list: async () => [...metadataStore.keys()],
		clear: async () => {
			metadataStore.clear();
		},
	};

	spyOn(
		service as unknown as { getProjectMediaAdapters: () => unknown },
		"getProjectMediaAdapters",
	).mockImplementation(() => ({ mediaMetadataAdapter, mediaAssetsAdapter }));

	return {
		fileStore,
		metadataStore,
		removedFiles,
		holdMetadataWrites: () => {
			heldMetadataWrites = [];
		},
		releaseMetadataWrites: () => {
			const held = heldMetadataWrites ?? [];
			heldMetadataWrites = null;
			for (const release of held) release();
		},
	};
}

/** Lets fire-and-forget storage work (pruning, queued writes) run to the end. */
export function flushStorageWork(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

export function mediaMetadata({
	id,
	type = "video",
	lastModified = 0,
}: {
	id: string;
	type?: MediaAssetData["type"];
	lastModified?: number;
}): MediaAssetData {
	return { id, name: `${id}.bin`, type, size: 4, lastModified };
}
