import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { processMediaAssets } from "@/media/processing";
import { downloadSaturnAsset } from "./asset-download";
import { shotFileName } from "./naming";
import { loadImportedShotIds, saveImportedShotIds } from "./project-shots";
import { projectShotSegments, type SaturnProjectShot } from "./types";

/** How far along the importer is. */
export interface SaturnImportProgress {
	/** Shots finished, whether they were downloaded or skipped. */
	done: number;
	total: number;
}

/**
 * How many shot videos to have in flight at once.
 *
 * Each one is a multi-megabyte download that is then decoded in the main
 * thread, so this is bounded by memory rather than by the network: every
 * in-flight shot holds a whole video, plus its decode buffers. A project's
 * renders average a few MB but the long tail is tens of MB, so this stays low.
 * Sequential downloads made a fully rendered project take tens of minutes; past
 * a handful the decode step, which cannot overlap, is what dominates anyway.
 */
const DOWNLOAD_CONCURRENCY = 3;

/** Runs `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>({
	items,
	limit,
	worker,
}: {
	items: T[];
	limit: number;
	worker: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const run = async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => run()),
	);

	return results;
}

/**
 * Pulls every rendered shot video of a project into the media library.
 *
 * Only the shots that already own a video are downloaded — the rest have no
 * bytes to fetch. A project that has barely started rendering therefore costs
 * almost nothing, while a fully rendered one is the full tens of GB.
 *
 * The timeline is never touched. The user drags clips in from the assets panel
 * themselves, so this can run entirely in the background while they work.
 *
 * Assets already in the library are skipped, so re-entering a project does not
 * download the same files again.
 *
 * Callers must not run two of these against the same project at once: the skip
 * list is only written at the end, so overlapping runs both see it empty and
 * download everything twice.
 */
export async function importSaturnShotMedia({
	editor,
	projectId,
	shots,
	signal,
	onProgress,
}: {
	editor: EditorCore;
	projectId: string;
	shots: SaturnProjectShot[];
	signal?: AbortSignal;
	onProgress?: (progress: SaturnImportProgress) => void;
}): Promise<Map<number, MediaAsset>> {
	// Segments, so a shot that carries its own render is taken as the one piece
	// of footage it is rather than descending into the frames that made it up.
	const withVideo = projectShotSegments(shots).filter(
		(shot): shot is SaturnProjectShot & { videoUrl: string } =>
			typeof shot.videoUrl === "string" && shot.videoUrl.length > 0,
	);

	/** Only the shots whose bytes are actually in the library. */
	const byShotId = new Map<number, MediaAsset>();

	if (withVideo.length === 0) return byShotId;

	// Which shots already made it into the library, recorded separately because
	// the media records themselves carry no upstream identity — nothing in a
	// MediaAsset says which Saturn shot it came from.
	const alreadyImported = loadImportedShotIds({ projectId });

	let done = 0;
	const report = () => {
		onProgress?.({ done, total: withVideo.length });
	};
	report();

	await mapWithConcurrency({
		items: withVideo,
		limit: DOWNLOAD_CONCURRENCY,
		worker: async (shot) => {
			if (signal?.aborted) return;

			if (alreadyImported.has(shot.shotId)) {
				const existing = editor.media
					.getAssets()
					.find((asset) => asset.name === shotFileName(shot));
				if (existing) byShotId.set(shot.shotId, existing);

				done += 1;
				report();
				return;
			}

			try {
				const file = await downloadSaturnAsset({
					url: shot.videoUrl,
					name: shotFileName(shot),
					signal,
				});

				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed) return;

				const created = await editor.media.addMediaAsset({
					projectId,
					asset: processed,
				});
				if (created) {
					byShotId.set(shot.shotId, created);
					alreadyImported.add(shot.shotId);
				}
			} catch (error) {
				// One unreachable shot must not abandon the rest of the library.
				console.warn(`[saturn] 素材导入失败：${shotFileName(shot)}`, error);
			} finally {
				done += 1;
				report();
			}
		},
	});

	// Written from `alreadyImported`, which now includes everything that landed
	// in this run. Only successes are in there: recording a shot whose download
	// failed would make it look imported forever and it could never be retried.
	saveImportedShotIds({ projectId, shotIds: alreadyImported });

	return byShotId;
}
