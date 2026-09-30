import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { generateUUID } from "@/utils/id";
import { storageService } from "@/services/storage/service";
import type { FrameRate } from "opencut-wasm";
import { hasMediaId } from "@/timeline/element-utils";
import { frameRatesEqual, getHighestImportedVideoFps } from "@/fps/utils";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { insertMediaAssetAt } from "./asset-list";

export class AddMediaAssetCommand extends Command {
	private assetId: string;
	private createdAsset: MediaAsset | null = null;
	/** Where the asset went in the list, so a redo puts it back there. */
	private insertedIndex = -1;
	private previousProjectFps: FrameRate | null = null;
	private appliedProjectFps: FrameRate | null = null;

	constructor({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}) {
		super();
		this.projectId = projectId;
		this.asset = asset;
		this.assetId = generateUUID();
	}

	private projectId: string;
	private asset: Omit<MediaAsset, "id">;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		if (!this.createdAsset) {
			this.createdAsset = {
				...this.asset,
				id: this.assetId,
			};
			this.insertedIndex = assets.length;
		}

		// Into the list as it is now; see `insertMediaAssetAt`.
		editor.media.setAssets({
			assets: insertMediaAssetAt({
				assets,
				asset: this.createdAsset,
				index: this.insertedIndex,
			}),
		});
		this.previousProjectFps = editor.project.getActiveOrNull()?.settings.fps ?? null;
		this.appliedProjectFps = editor.project.ratchetFpsForImportedMedia({
			importedAssets: [this.createdAsset],
		});

		storageService
			.saveMediaAsset({
				projectId: this.projectId,
				mediaAsset: this.createdAsset,
			})
			.catch((error) => {
				console.error("Failed to save media item:", error);

				const currentAssets = editor.media.getAssets();
				editor.media.setAssets({
					assets: currentAssets.filter((asset) => asset.id !== this.assetId),
				});

				const currentTracks = editor.scenes.getActiveScene().tracks;
				const orphanedElements: Array<{ trackId: string; elementId: string }> =
					[];

				for (const track of [
					...currentTracks.overlay,
					currentTracks.main,
					...currentTracks.audio,
				]) {
					for (const element of track.elements) {
						if (hasMediaId(element) && element.mediaId === this.assetId) {
							orphanedElements.push({
								trackId: track.id,
								elementId: element.id,
							});
						}
					}
				}

				if (orphanedElements.length > 0) {
					editor.timeline.deleteElements({ elements: orphanedElements });
				}

				this.restoreProjectFpsAfterFailedSave({ editor });

				if (storageService.isQuotaExceededError({ error })) {
					toast.error("浏览器存储空间不足", {
						description: error instanceof Error ? error.message : undefined,
					});
				}
			});

		return undefined;
	}

	undo(): void {
		if (!this.createdAsset) return;

		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();
		const current = assets.find((asset) => asset.id === this.assetId);
		if (current) {
			// Only this asset comes out; the rest of the list may have changed
			// since, see `insertMediaAssetAt`.
			editor.media.setAssets({
				assets: assets.filter((asset) => asset.id !== this.assetId),
			});
			if (current.url) {
				URL.revokeObjectURL(current.url);
			}
		}

		storageService
			.deleteMediaAsset({ projectId: this.projectId, id: this.assetId })
			.catch((error) => {
				console.error("Failed to delete media item on undo:", error);
			});
	}

	redo(): CommandResult | undefined {
		if (this.createdAsset) {
			// `undo` revoked the URL along with taking the asset out.
			this.createdAsset = {
				...this.createdAsset,
				url: URL.createObjectURL(this.createdAsset.file),
			};
		}
		return this.execute();
	}

	getAssetId(): string {
		return this.assetId;
	}

	private restoreProjectFpsAfterFailedSave({
		editor,
	}: {
		editor: EditorCore;
	}): void {
		if (this.previousProjectFps === null || this.appliedProjectFps === null) return;

		const activeProject = editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (
			!this.appliedProjectFps ||
			!frameRatesEqual({
				a: activeProject.settings.fps,
				b: this.appliedProjectFps,
			})
		)
			return;

		const highestRemainingVideoFps = getHighestImportedVideoFps({
			mediaAssets: editor.media.getAssets(),
		});
		const appliedFpsFloat = this.appliedProjectFps.numerator / this.appliedProjectFps.denominator;
		if (
			highestRemainingVideoFps !== null &&
			highestRemainingVideoFps >= appliedFpsFloat
		) {
			return;
		}

		new UpdateProjectSettingsCommand({ fps: this.previousProjectFps }).execute();
	}
}
