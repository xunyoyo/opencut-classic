import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { toElementDurationTicks } from "@/timeline/creation";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { addMediaTime, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import {
	hasRenderedVideo,
	saturnShotListResponseSchema,
	type RenderedShot,
	type SaturnShot,
} from "./types";

/**
 * Rebuilds an AI-Saturn scene ("场次") as an editable OpenCut project.
 *
 * AI-Saturn already knows the cut: shots come back from `queryShotList` in
 * storyboard order, each with a rendered video. Its own `genFinalVideo` flattens
 * that into a single mp4 by re-encoding frame by frame, which discards the
 * structure. Here we lay the same shots end to end on the main track so the
 * cut stays editable.
 */

export interface ImportProgress {
	/** What the importer is doing right now, ready to show verbatim. */
	label: string;
	/** 0–1, or null while the total is still unknown. */
	ratio: number | null;
}

export interface ImportSaturnViewParams {
	editor: EditorCore;
	viewId: number;
	/** 1: 九宫格分镜, 2: 故事板分镜. Matches AI-Saturn's `type`. */
	type: number;
	/** RuoYi bearer token, forwarded to AI-Saturn as-is. */
	token: string;
	projectName: string;
	onProgress?: ({ progress }: { progress: ImportProgress }) => void;
	signal?: AbortSignal;
}

export interface ImportSaturnViewResult {
	projectId: string;
	importedCount: number;
	/** Shots that exist upstream but have no rendered video yet. */
	skippedCount: number;
}

async function fetchShots({
	viewId,
	type,
	token,
	signal,
}: {
	viewId: number;
	type: number;
	token: string;
	signal?: AbortSignal;
}): Promise<SaturnShot[]> {
	const url = new URL("/api/saturn/shots", window.location.origin);
	url.searchParams.set("viewId", String(viewId));
	url.searchParams.set("type", String(type));

	const response = await fetch(url, {
		headers: { Authorization: token },
		signal,
	});

	if (response.status === 401) {
		throw new Error("AI-Saturn 登录态已失效，请重新获取 token");
	}

	if (!response.ok) {
		throw new Error(`获取分镜列表失败（HTTP ${response.status}）`);
	}

	const parsed = saturnShotListResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("AI-Saturn 返回了无法解析的分镜数据");
	}

	if (parsed.data.code !== 200) {
		throw new Error(parsed.data.msg || "AI-Saturn 返回了错误");
	}

	return parsed.data.data ?? [];
}

async function downloadShotVideo({
	shot,
	signal,
}: {
	shot: RenderedShot;
	signal?: AbortSignal;
}): Promise<File> {
	const url = new URL("/api/saturn/asset", window.location.origin);
	url.searchParams.set("url", shot.video.storePath);

	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(
			`下载镜头 ${shot.shotNo ?? shot.shotId} 的视频失败（HTTP ${response.status}）`,
		);
	}

	const blob = await response.blob();
	const suffix = shot.video.suffix?.replace(/^\./, "") ?? "mp4";
	const name = shot.video.name ?? `镜头${shot.shotNo ?? shot.shotId}.${suffix}`;

	return new File([blob], name, {
		type: blob.type || "video/mp4",
	});
}

export async function importSaturnView({
	editor,
	viewId,
	type,
	token,
	projectName,
	onProgress,
	signal,
}: ImportSaturnViewParams): Promise<ImportSaturnViewResult> {
	const report = ({ label, ratio }: ImportProgress) => {
		onProgress?.({ progress: { label, ratio } });
	};

	report({ label: "正在读取分镜列表…", ratio: null });
	const shots = await fetchShots({ viewId, type, token, signal });

	// Upstream returns shots in storyboard order, so we keep it rather than
	// sorting on `shotNo` — that field is a free-form string ("2A", "10") and
	// re-sorting it here would only introduce a second, worse ordering.
	const renderedShots = shots.filter(hasRenderedVideo);

	if (renderedShots.length === 0) {
		throw new Error("该场次还没有生成好的分镜视频");
	}

	const files: File[] = [];
	for (const [index, shot] of renderedShots.entries()) {
		report({
			label: `正在下载分镜视频 ${index + 1}/${renderedShots.length}…`,
			ratio: index / renderedShots.length,
		});
		files.push(await downloadShotVideo({ shot, signal }));
	}

	report({ label: "正在创建项目…", ratio: null });
	const projectId = await editor.project.createNewProject({
		name: projectName,
	});

	// The editor operates on whatever project is active, and creating one does
	// not activate it. Load it before touching media or the timeline.
	await editor.project.loadProject({ id: projectId });

	report({ label: "正在解析视频…", ratio: null });
	const processedAssets = await processMediaAssets({
		files,
		onProgress: ({ progress }) => {
			report({ label: "正在解析视频…", ratio: progress / 100 });
		},
	});

	const mainTrackId = editor.scenes.getActiveScene().tracks.main.id;
	let cursor: MediaTime = ZERO_MEDIA_TIME;
	let importedCount = 0;

	// Sequential on purpose: each insert advances the cursor that positions the
	// next shot, so the clips end up butted against each other in order.
	for (const [index, asset] of processedAssets.entries()) {
		report({
			label: `正在铺设时间线 ${index + 1}/${processedAssets.length}…`,
			ratio: index / processedAssets.length,
		});

		const createdAsset = await editor.media.addMediaAsset({
			projectId,
			asset,
		});
		if (!createdAsset) continue;

		// Use the decoded duration rather than the shot's planned `duration`:
		// the rendered video is what actually sits on the timeline, and the two
		// routinely disagree.
		const duration = toElementDurationTicks({
			seconds: createdAsset.duration,
		});

		editor.timeline.insertElement({
			element: buildElementFromMedia({
				mediaId: createdAsset.id,
				mediaType: createdAsset.type,
				name: createdAsset.name,
				duration,
				startTime: cursor,
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		});

		cursor = addMediaTime({ a: cursor, b: duration });
		importedCount += 1;
	}

	report({ label: "正在保存…", ratio: 1 });
	await editor.project.saveCurrentProject();

	return {
		projectId,
		importedCount,
		skippedCount: shots.length - renderedShots.length,
	};
}
