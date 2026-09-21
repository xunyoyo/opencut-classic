import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { toElementDurationTicks } from "@/timeline/creation";
import { UpdateElementsCommand } from "@/commands/timeline/element";
import { MoveElementCommand } from "@/commands/timeline/element/move-elements";
import type { PlannedElementMove } from "@/timeline/group-move/types";
import {
	ZERO_MEDIA_TIME,
	addMediaTime,
	maxMediaTime,
	mediaTimeToSeconds,
	subMediaTime,
	type MediaTime,
} from "@/wasm";
import type { SaturnClipLink } from "./project-shots";

/**
 * Replaces a placeholder clip with the shot's rendered video.
 *
 * The placeholder is turned into a video element in place — the element id and
 * its position on the track are kept, so everything the user has already done
 * to that clip (retiming, effects, a moved start) survives the swap.
 *
 * Duration is taken from the decoded video rather than the planned one. The two
 * routinely disagree, and the rendered file is what actually plays, so trusting
 * the plan would show a black tail or cut the picture off. The cost is that the
 * timeline shifts, which is handled explicitly below.
 */
export async function replaceClipWithVideo({
	editor,
	projectId,
	elementId,
	link,
	onProgress,
	signal,
}: {
	editor: EditorCore;
	projectId: string;
	elementId: string;
	link: SaturnClipLink;
	onProgress?: (state: { stage: "downloading" | "decoding" | "applying" }) => void;
	signal?: AbortSignal;
}): Promise<{ durationSeconds: number }> {
	if (!link.videoUrl) {
		throw new Error(
			link.shotNo
				? `镜头 ${link.shotNo} 还没有生成好的视频`
				: "这个镜头还没有生成好的视频",
		);
	}

	onProgress?.({ stage: "downloading" });
	const file = await downloadShotFile({ link, signal });

	onProgress?.({ stage: "decoding" });
	const [asset] = await processMediaAssets({ files: [file] });
	if (!asset) {
		throw new Error("无法解析下载到的视频");
	}

	const createdAsset = await editor.media.addMediaAsset({ projectId, asset });
	if (!createdAsset) {
		throw new Error("视频入库失败");
	}

	onProgress?.({ stage: "applying" });

	// Derived from the decoded media, not the shot's planned duration.
	const nextDuration = toElementDurationTicks({
		seconds: createdAsset.duration,
	});

	// Placeholders are always laid out on the main track, so the track is known
	// without a lookup — and looking one up would need the track id to find the
	// element in the first place.
	const mainTrack = editor.scenes.getActiveScene().tracks.main;
	const trackId = mainTrack.id;
	const element = mainTrack.elements.find((item) => item.id === elementId);
	if (!element) {
		throw new Error("找不到要替换的片段，可能已被删除");
	}
	const previousDuration = element.duration;

	editor.command.execute({
		command: new UpdateElementsCommand({
			updates: [
				{
					trackId,
					elementId,
					patch: {
						type: "video",
						mediaId: createdAsset.id,
						duration: nextDuration,
					},
				},
			],
		}),
	});

	// Everything after this clip moves by however much the clip grew or shrank,
	// so the cut stays contiguous instead of opening a gap or overlapping.
	shiftFollowingClips({
		editor,
		trackId,
		after: element.startTime,
		delta: subMediaTime({ a: nextDuration, b: previousDuration }),
	});

	await editor.project.saveCurrentProject();

	return { durationSeconds: mediaTimeToSeconds({ time: nextDuration }) };
}

/**
 * Moves every clip that starts after `after` on the same track by `delta`.
 *
 * A zero delta is common (the render matched the plan) and is skipped so it
 * does not push a no-op command onto the undo stack.
 */
function shiftFollowingClips({
	editor,
	trackId,
	after,
	delta,
}: {
	editor: EditorCore;
	trackId: string;
	after: MediaTime;
	delta: MediaTime;
}): void {
	if (delta === 0) return;

	const track = editor.timeline.getTrackById({ trackId });
	if (!track) return;

	const moves: PlannedElementMove[] = track.elements
		.filter((element) => element.startTime >= after)
		.map((element) => ({
			sourceTrackId: trackId,
			targetTrackId: trackId,
			elementId: element.id,
			// Clamped at zero: a shrink larger than a following clip's start time
			// would otherwise push it to a negative position.
			newStartTime: maxMediaTime({
				a: ZERO_MEDIA_TIME,
				b: addMediaTime({ a: element.startTime, b: delta }),
			}),
		}));

	if (moves.length === 0) return;

	editor.command.execute({ command: new MoveElementCommand({ moves }) });
}

async function downloadShotFile({
	link,
	signal,
}: {
	link: SaturnClipLink;
	signal?: AbortSignal;
}): Promise<File> {
	const url = new URL("/api/saturn/asset", window.location.origin);
	url.searchParams.set("url", link.videoUrl ?? "");

	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`下载视频失败（HTTP ${response.status}）`);
	}

	const blob = await response.blob();
	const suffix = link.videoSuffix?.replace(/^\./, "") ?? "mp4";
	const name = link.videoName ?? `镜头${link.shotNo ?? ""}.${suffix}`;

	return new File([blob], name, { type: blob.type || "video/mp4" });
}
