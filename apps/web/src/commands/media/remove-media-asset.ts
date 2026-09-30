import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks } from "@/timeline";
import { insertMediaAssetAt } from "./asset-list";

export class RemoveMediaAssetCommand extends Command {
	private savedTracks: SceneTracks | null = null;
	private removedAsset: MediaAsset | null = null;
	/** Where `removedAsset` sat in the list, so undo can put it back there. */
	private removedIndex = -1;
	/**
	 * Whether the removal is in effect (executed or redone, and not undone).
	 * Only then are the bytes kept in storage waiting on this command alone.
	 */
	private isApplied = false;
	/**
	 * This command's storage writes, chained so they land in the order they
	 * were issued. Each is started from a synchronous execute/undo and not
	 * awaited, and a quick undo must not have its metadata write overtaken
	 * by the removal's delete of that same record.
	 */
	private storageQueue: Promise<void> = Promise.resolve();

	constructor({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
	}

	private projectId: string;
	private assetId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		this.savedTracks = editor.scenes.getActiveScene().tracks;

		this.removedIndex = assets.findIndex((media) => media.id === this.assetId);
		this.removedAsset = assets[this.removedIndex] ?? null;

		if (!this.removedAsset) {
			console.error("Media asset not found:", this.assetId);
			return;
		}

		if (this.removedAsset.url) {
			URL.revokeObjectURL(this.removedAsset.url);
		}
		if (this.removedAsset.thumbnailUrl) {
			URL.revokeObjectURL(this.removedAsset.thumbnailUrl);
		}

		videoCache.clearVideo({ mediaId: this.assetId });
		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({
				kind: "media",
				id: this.assetId,
			}),
		});

		editor.media.setAssets({
			assets: assets.filter((media) => media.id !== this.assetId),
		});

		const elementsToRemove: Array<{ trackId: string; elementId: string }> = [];

		for (const track of [
			...this.savedTracks.overlay,
			this.savedTracks.main,
			...this.savedTracks.audio,
		]) {
			for (const element of track.elements) {
				if (hasMediaId(element) && element.mediaId === this.assetId) {
					elementsToRemove.push({ trackId: track.id, elementId: element.id });
				}
			}
		}

		if (elementsToRemove.length > 0) {
			editor.timeline.deleteElements({ elements: elementsToRemove });
		}

		// Metadata only: `removedAsset.file` is read back from OPFS, so undo
		// needs the bytes to still be there. `dispose` deletes them once this
		// removal can no longer be undone. An asset removed while its import is
		// still saving waits for that save, which would otherwise write its
		// record after this delete and bring the asset back on reload.
		const media = editor.media;
		this.queueStorage({
			write: async () => {
				await media.whenSaved({ id: this.assetId });
				await storageService.deleteMediaAssetMetadata({
					projectId: this.projectId,
					id: this.assetId,
				});
			},
			failureMessage: "Failed to delete media item:",
		});
		this.isApplied = true;
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.removedAsset) {
			const assets = editor.media.getAssets();
			if (!assets.some((media) => media.id === this.assetId)) {
				const restoredAsset: MediaAsset = {
					...this.removedAsset,
					// The removal revoked the old URL. `file` carries its type
					// (`restoreStoredMediaFileType`), so an SVG's URL renders too.
					url: URL.createObjectURL(this.removedAsset.file),
				};

				// Into the list as it is now; see `insertMediaAssetAt`.
				editor.media.setAssets({
					assets: insertMediaAssetAt({
						assets,
						asset: restoredAsset,
						index: this.removedIndex,
					}),
				});

				this.queueStorage({
					write: () =>
						storageService.restoreMediaAsset({
							projectId: this.projectId,
							mediaAsset: restoredAsset,
						}),
					failureMessage: "Failed to restore media item on undo:",
				});
			}
			this.isApplied = false;
		}

		if (this.savedTracks) {
			editor.timeline.updateTracks(this.savedTracks);
		}
	}

	dispose(): void {
		if (!this.isApplied) return;
		this.isApplied = false;
		this.removedAsset = null;

		// Nothing can undo this removal any more, so nothing will read the
		// bytes it kept. Queued behind the metadata delete: the storage side
		// refuses to drop bytes a metadata record still points at.
		this.queueStorage({
			write: () =>
				storageService.deleteOrphanedMediaFile({
					projectId: this.projectId,
					id: this.assetId,
				}),
			failureMessage: "Failed to delete removed media file:",
		});
	}

	private queueStorage({
		write,
		failureMessage,
	}: {
		write: () => Promise<void>;
		failureMessage: string;
	}): void {
		this.storageQueue = this.storageQueue.then(write).catch((error) => {
			console.error(failureMessage, error);
		});
	}
}
