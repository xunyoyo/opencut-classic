import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			const persistedAsset = await this.adoptPersistedFile({
				projectId,
				asset: newAsset,
			});
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [persistedAsset],
			});
			return persistedAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("浏览器存储空间不足", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveMediaAssetCommand({
								projectId,
								assetId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			// Every load mints a fresh object URL per asset, so the batch being
			// replaced has to give its URLs back or each reload leaks one per
			// asset for the life of the page.
			this.revokeAssetUrls({ assets: this.assets, keep: mediaAssets });
			this.assets = mediaAssets;
			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.revokeAssetUrls({ assets: this.assets });

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();
		waveformCache.clearAll();

		this.revokeAssetUrls({ assets: this.assets });

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Revokes the object URLs held by `assets`, skipping any URL an asset in
	 * `keep` still points at.
	 *
	 * Only `blob:` URLs are object URLs: thumbnails are data URLs, which own no
	 * browser-side resource and are dropped with the string.
	 */
	private revokeAssetUrls({
		assets,
		keep = [],
	}: {
		assets: MediaAsset[];
		keep?: MediaAsset[];
	}): void {
		const stillInUse = new Set(
			keep.flatMap((asset) => [asset.url, asset.thumbnailUrl]),
		);

		for (const asset of assets) {
			for (const url of [asset.url, asset.thumbnailUrl]) {
				if (url?.startsWith("blob:") && !stillInUse.has(url)) {
					URL.revokeObjectURL(url);
				}
			}
		}
	}

	/**
	 * Swaps a just-saved asset's `file` and `url` for ones read back from OPFS.
	 *
	 * An imported file (a download, a drop, a paste) lives on the JS heap, and
	 * both the asset's `file` and the object URL minted from it keep it there
	 * for as long as the asset exists — a whole video per asset, which is what
	 * runs a large import out of memory. The copy read back from OPFS is a
	 * handle on the bytes on disk, the same thing a reloaded project holds, so
	 * once nothing references the original the heap copy can be collected.
	 *
	 * Falls back to the asset as saved when the read-back fails: that keeps the
	 * old memory profile for this one asset instead of losing it.
	 */
	private async adoptPersistedFile({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: MediaAsset;
	}): Promise<MediaAsset> {
		let stored: MediaAsset | null = null;
		try {
			stored = await storageService.loadMediaAsset({
				projectId,
				id: asset.id,
			});
		} catch (error) {
			console.warn("Failed to read back saved media file:", error);
		}
		if (!stored) return asset;

		// Looked up again rather than taken from `asset`: the save is async, and
		// the asset may have been removed (or the project closed) meanwhile.
		const current = this.assets.find((item) => item.id === asset.id);
		if (!current) {
			if (stored.url) URL.revokeObjectURL(stored.url);
			return asset;
		}

		const persistedAsset: MediaAsset = {
			...current,
			file: stored.file,
			url: stored.url,
		};
		this.assets = this.assets.map((item) =>
			item.id === asset.id ? persistedAsset : item,
		);
		if (current.url) URL.revokeObjectURL(current.url);
		// A sink opened while the save was running reads the heap copy and
		// would keep it alive; the next frame reopens it on the stored file.
		videoCache.clearVideo({ mediaId: asset.id });
		this.notify();
		return persistedAsset;
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
