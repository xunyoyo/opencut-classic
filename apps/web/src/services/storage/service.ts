import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import {
	type StorageCapacityCheckResult,
	StorageQuotaExceededError,
	evaluateStorageCapacity,
	isStorageQuotaExceededError,
	readStorageQuotaStatus,
} from "./quota";
import type { MediaAssetData, StorageConfig, SerializedProject } from "./types";
import {
	type StoredMediaFileEntry,
	selectOrphanedMediaFileKeys,
} from "./media-orphans";
import { restoreStoredMediaFileType } from "./media-file-type";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import {
	migrations,
	runStorageMigrations,
} from "@/services/storage/migrations";
import type { Bookmark, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";
import { serializeProject } from "@/versions/serialize";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

class StorageService {
	private projectsAdapter: IndexedDBAdapter<SerializedProject>;
	private savedSoundsAdapter: IndexedDBAdapter<SavedSoundsData>;
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;
	/**
	 * Saves in flight, keyed `${projectId}/${id}`, counted because the same
	 * asset can be written twice at once (an undo/redo racing the first save).
	 */
	private mediaFilesBeingSaved = new Map<string, number>();

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};

		this.projectsAdapter = new IndexedDBAdapter<SerializedProject>({
			dbName: this.config.projectsDb,
			storeName: "projects",
			version: this.config.version,
		});

		this.savedSoundsAdapter = new IndexedDBAdapter<SavedSoundsData>({
			dbName: this.config.savedSoundsDb,
			storeName: "saved-sounds",
			version: this.config.version,
		});
	}

	private async ensureMigrations(): Promise<void> {
		if (this.migrationsPromise) {
			await this.migrationsPromise;
			return;
		}

		this.migrationsPromise = runStorageMigrations({ migrations }).then(
			() => undefined,
		);
		await this.migrationsPromise;
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		const quotaStatus = await readStorageQuotaStatus();
		return evaluateStorageCapacity({
			requiredBytes: size,
			quotaStatus,
		});
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });

		// Shared with the version store's snapshots, so a saved project and a
		// saved version of that same project are byte-identical. Two copies of
		// this enumeration would drift, and the next `TProjectMetadata` field
		// added would be dropped in whichever copy was missed.
		const serializedProject: SerializedProject = serializeProject({
			project,
			duration,
		});

		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializedProject,
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({ scenes }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
				// Rebuilt field by field, so anything not named here is dropped on
				// every load — the upstream owner has to be carried across
				// explicitly or the project loses its AI-Saturn link on reload.
				...(serializedProject.metadata.saturnProjectId !== undefined && {
					saturnProjectId: serializedProject.metadata.saturnProjectId,
				}),
				...(serializedProject.metadata.saturnLaidOut !== undefined && {
					saturnLaidOut: serializedProject.metadata.saturnLaidOut,
				}),
			},
			scenes,
			currentSceneId: serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
				// Same reason as in loadProject: this is a field-by-field rebuild,
				// and the draft list filters on the upstream owner.
				...(serializedProject.metadata.saturnProjectId !== undefined && {
					saturnProjectId: serializedProject.metadata.saturnProjectId,
				}),
				...(serializedProject.metadata.saturnLaidOut !== undefined && {
					saturnLaidOut: serializedProject.metadata.saturnLaidOut,
				}),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	private buildMediaMetadata({
		mediaAsset,
		size,
		lastModified,
	}: {
		mediaAsset: MediaAsset;
		size: number;
		lastModified: number;
	}): MediaAssetData {
		return {
			id: mediaAsset.id,
			name: mediaAsset.name,
			type: mediaAsset.type,
			size,
			lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
		};
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const metadata = this.buildMediaMetadata({
			mediaAsset,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
		});

		const savingKey = `${projectId}/${mediaAsset.id}`;
		this.mediaFilesBeingSaved.set(
			savingKey,
			(this.mediaFilesBeingSaved.get(savingKey) ?? 0) + 1,
		);

		try {
			await mediaAssetsAdapter.set({
				key: mediaAsset.id,
				value: mediaAsset.file,
			});
			await mediaMetadataAdapter.set({
				key: mediaAsset.id,
				value: metadata,
			});
		} catch (error) {
			try {
				await mediaAssetsAdapter.remove(mediaAsset.id);
			} catch {
				// Ignore cleanup failures so the original storage error is preserved.
			}

			if (this.isQuotaExceededError({ error })) {
				throw new StorageQuotaExceededError({
					requiredBytes: mediaAsset.file.size,
				});
			}

			throw error;
		} finally {
			const remaining = (this.mediaFilesBeingSaved.get(savingKey) ?? 1) - 1;
			if (remaining > 0) {
				this.mediaFilesBeingSaved.set(savingKey, remaining);
			} else {
				this.mediaFilesBeingSaved.delete(savingKey);
			}
		}
	}

	/**
	 * Whether a `saveMediaAsset` for this asset is still running.
	 *
	 * Its bytes then exist without a metadata record, which is exactly what an
	 * orphan looks like, so every path that deletes orphaned bytes asks first.
	 */
	private isMediaFileBeingSaved({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): boolean {
		return this.mediaFilesBeingSaved.has(`${projectId}/${id}`);
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		// `file` comes from `FileSystemFileHandle.getFile()`: a handle on the
		// bytes in OPFS, read from disk on demand rather than held on the heap.
		// `MediaManager` relies on this to let go of freshly imported files.
		// (An SVG is the exception: it is re-read to get its type back, and
		// is small enough for that not to matter.)
		const [storedFile, metadata] = await Promise.all([
			mediaAssetsAdapter.get(id),
			mediaMetadataAdapter.get(id),
		]);

		if (!storedFile || !metadata) return null;

		const file = await restoreStoredMediaFileType({
			file: storedFile,
			type: metadata.type,
		});
		const url = URL.createObjectURL(file);

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
		};
	}

	/**
	 * Reads every asset of a project back from storage.
	 *
	 * `pruneOrphanedFiles` also deletes the stored bytes no metadata record
	 * points at. Those include the bytes of removals that can still be undone
	 * (see `deleteMediaAssetMetadata`), so only a caller that has just dropped
	 * the undo history — opening the project for editing — may pass it.
	 * Anything else that merely reads a project's media (duplicating it, say)
	 * must leave them alone: the project may be the one open in the editor.
	 */
	async loadAllMediaAssets({
		projectId,
		pruneOrphanedFiles = false,
	}: {
		projectId: string;
		pruneOrphanedFiles?: boolean;
	}): Promise<MediaAsset[]> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();
		const mediaItems: MediaAsset[] = [];

		for (const id of mediaIds) {
			const item = await this.loadMediaAsset({ projectId, id });
			if (item) {
				mediaItems.push(item);
			}
		}

		// Off the load path: nothing here depends on it, and a failure only
		// means the orphaned bytes survive until the next time the project opens.
		if (pruneOrphanedFiles) {
			void this.pruneOrphanedMediaFiles({ projectId, mediaIds }).catch(
				(error) => {
					console.warn("Failed to prune orphaned media files:", error);
				},
			);
		}

		return mediaItems;
	}

	/**
	 * Drops the metadata record of an asset but keeps its bytes.
	 *
	 * For removals that can be undone. The in-memory asset's `file` is read back
	 * from OPFS, so it is only a handle on those bytes: deleting them would leave
	 * undo holding a `File` that can no longer be read. The bytes left behind
	 * are deleted by `deleteOrphanedMediaFile` once the removal drops out of the
	 * undo history, or by `pruneOrphanedMediaFiles` the next time the project
	 * opens if the page went away first.
	 */
	async deleteMediaAssetMetadata({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		await mediaMetadataAdapter.remove(id);
	}

	/**
	 * Puts back an asset removed through `deleteMediaAssetMetadata`.
	 *
	 * When its bytes are still stored only the metadata record is written:
	 * rewriting the file from `mediaAsset.file` would replace the very file that
	 * `File` reads from, and a `File` read from OPFS stops being readable once
	 * the underlying file changes. Falls back to a full save when the bytes are
	 * gone (e.g. the asset was removed through `deleteMediaAsset`).
	 */
	async restoreMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		const storedFile = await mediaAssetsAdapter.get(mediaAsset.id);
		if (!storedFile) {
			await this.saveMediaAsset({ projectId, mediaAsset });
			return;
		}

		await mediaMetadataAdapter.set({
			key: mediaAsset.id,
			value: this.buildMediaMetadata({
				mediaAsset,
				size: storedFile.size,
				lastModified: mediaAsset.file.lastModified,
			}),
		});
	}

	/**
	 * Deletes the bytes `deleteMediaAssetMetadata` kept for undo, once the
	 * removal can no longer be undone.
	 *
	 * Does nothing while the asset is still being saved or when a metadata
	 * record points at the bytes again: in both cases they are not orphaned,
	 * and deleting them would lose a file that is in use.
	 */
	async deleteOrphanedMediaFile({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		if (await mediaMetadataAdapter.get(id)) return;
		// Checked after the read, right before deleting, so a save that
		// started while the record was being read is seen too.
		if (this.isMediaFileBeingSaved({ projectId, id })) return;

		await mediaAssetsAdapter.remove(id);
	}

	private async pruneOrphanedMediaFiles({
		projectId,
		mediaIds,
	}: {
		projectId: string;
		mediaIds: string[];
	}): Promise<void> {
		const { mediaAssetsAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const known = new Set(mediaIds);
		const candidates: StoredMediaFileEntry[] = [];
		for (const key of await mediaAssetsAdapter.list()) {
			if (known.has(key)) continue;
			if (this.isMediaFileBeingSaved({ projectId, id: key })) continue;
			const file = await mediaAssetsAdapter.get(key);
			if (file) {
				candidates.push({ key, lastModified: file.lastModified });
			}
		}

		const orphanedKeys = selectOrphanedMediaFileKeys({
			files: candidates,
			metadataIds: known,
			now: Date.now(),
		});
		for (const key of orphanedKeys) {
			await mediaAssetsAdapter.remove(key);
		}
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaAssetsAdapter.remove(id),
			mediaMetadataAdapter.remove(id),
		]);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		const { mediaMetadataAdapter, mediaAssetsAdapter } =
			this.getProjectMediaAdapters({ projectId });

		await Promise.all([
			mediaMetadataAdapter.clear(),
			mediaAssetsAdapter.clear(),
		]);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const { mediaMetadataAdapter } = this.getProjectMediaAdapters({
			projectId,
		});

		const mediaIds = await mediaMetadataAdapter.list();

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return this.isIndexedDBSupported() && this.isOPFSSupported();
	}
}

export const storageService = new StorageService();
export { StorageService };
