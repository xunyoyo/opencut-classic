import type { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { processMediaAssets } from "@/media/processing";
import { downloadSaturnAsset } from "./asset-download";
import { shotFileName } from "./naming";
import { loadImportedShotIds, saveImportedShotIds } from "./project-shots";
import { sortedProjectShotSegments, type SaturnProjectShot } from "./types";

/** How far along the importer is. */
export interface SaturnImportProgress {
	/** Shots finished, whether they were downloaded or skipped. */
	done: number;
	total: number;
	/**
	 * How many of `done` did not make it into the library.
	 *
	 * Reported because the download can fail per shot and the run still finishes
	 * successfully: without the count, a project whose renders partly timed out
	 * ends on "素材库新增 30 个成片" next to a 37/37 progress bar, and nothing
	 * tells the user which seven are missing.
	 */
	failed: number;
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

/**
 * How long a single shot is allowed to take before it is given up on.
 *
 * The decode probe is the only unbounded step in the pipeline: mediabunny reads
 * the container to get duration, dimensions and fps, and a file it cannot make
 * sense of can leave that promise pending forever. Without a deadline that shot
 * holds its slot for the life of the page, and with three slots the whole
 * library import stalls behind files that will never finish.
 *
 * Generous on purpose — the largest renders are tens of megabytes and are
 * decoded on the main thread, so a slow success must not be mistaken for a
 * hang. Failing a shot is recoverable: it is not recorded as imported, so the
 * next visit retries it.
 */
const SHOT_TIMEOUT_MS = 120_000;

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
	// Sorted by episode → scene → shot, because this list is the download queue:
	// taking it in upstream's order would interleave 第1集第1场镜1 with the same
	// shot number from every other episode. See `compareProjectShots`.
	const withVideo = sortedProjectShotSegments(shots).filter(
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
	let failed = 0;
	const report = () => {
		onProgress?.({ done, total: withVideo.length, failed });
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

			// Set once the bytes are in the library. Read in `finally`, which is
			// where every path out of this worker converges — the two early
			// returns above and below as well as a thrown download — so the
			// failure count cannot be missed by a path that simply returns.
			let landed = false;

			// One deadline per shot, chained to the caller's signal so a cancelled
			// import still stops immediately. The timer is what makes a wedged
			// decode recoverable; the abort is what makes cancellation work.
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), SHOT_TIMEOUT_MS);
			const onOuterAbort = () => timeout.abort();
			signal?.addEventListener("abort", onOuterAbort);

			try {
				const file = await downloadSaturnAsset({
					url: shot.videoUrl,
					name: shotFileName(shot),
					signal: timeout.signal,
				});

				// The decode probe takes no signal, so a shot that ran out of time
				// during the download would still be decoded — which is the whole
				// cost this deadline exists to avoid. Checked here as well as at
				// the top of the worker.
				if (timeout.signal.aborted) return;

				const [processed] = await processMediaAssets({ files: [file] });
				if (!processed) return;

				const created = await editor.media.addMediaAsset({
					projectId,
					asset: processed,
				});
				if (created) {
					byShotId.set(shot.shotId, created);
					alreadyImported.add(shot.shotId);
					landed = true;
				}
			} catch (error) {
				// One unreachable shot must not abandon the rest of the library.
				console.warn(`[saturn] 素材导入失败：${shotFileName(shot)}`, error);
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onOuterAbort);
				// A cancelled run is not a failed one: the shots it never reached
				// are still pending, and counting them as failures would report
				// the whole library as broken every time the user navigates away.
				// The deadline abort is the opposite case — that one is a failure
				// and the shot it killed is already outside this batch.
				if (!landed && !signal?.aborted) failed += 1;
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
