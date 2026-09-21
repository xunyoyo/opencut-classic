import { buildTextElement } from "@/timeline/element-utils";
import { toElementDurationTicks } from "@/timeline/creation";
import { ZERO_MEDIA_TIME, addMediaTime, type MediaTime } from "@/wasm";
import type { EditorCore } from "@/core";
import { InsertElementCommand } from "@/commands/timeline/element";
import type { SaturnClipLink } from "./project-shots";
import {
	flattenProjectShots,
	projectShotViewLabel,
	type SaturnProjectShot,
} from "./types";

/**
 * Lays a prefetched AI-Saturn project out as a full-length timeline of
 * placeholder clips.
 *
 * The point is that a user arriving from the platform should see their whole
 * project the moment the editor opens — every shot, at its real duration, in
 * order — rather than a blank scene they have to build by hand. The media
 * bytes are not prefetched (a project's shots run to tens of GB), so each clip
 * starts as a text element carrying what AI-Saturn knows about the shot. A user
 * can read the cut, retime it, and replace individual placeholders with the
 * rendered video as they go.
 *
 * Text rather than an empty video element on purpose: a video element with no
 * mediaId renders nothing and is not obviously actionable, whereas text shows
 * the shot's content and dialogue where the picture will go.
 *
 * Returns the element-id → shot mapping, because the element ids are generated
 * inside the insert command and are the only stable way back to the shot once
 * the user starts moving clips around.
 */
export function buildPlaceholderTimeline({
	editor,
	shots,
}: {
	editor: EditorCore;
	shots: SaturnProjectShot[];
}): Record<string, SaturnClipLink> {
	const flat = flattenProjectShots(shots);
	if (flat.length === 0) return {};

	const mainTrackId = editor.scenes.getActiveScene().tracks.main.id;
	const links: Record<string, SaturnClipLink> = {};

	let cursor: MediaTime = ZERO_MEDIA_TIME;

	// Sequential on purpose: each insert advances the cursor that positions the
	// next shot, which is what butts the clips against each other in order.
	for (const shot of flat) {
		const duration = toElementDurationTicks({ seconds: shot.duration });

		// Built as a command rather than through `editor.timeline.insertElement`
		// so the generated element id is reachable — the timeline manager only
		// executes the command and discards it.
		const command = new InsertElementCommand({
			element: buildTextElement({
				raw: {
					name: shotLabel(shot),
					duration,
					params: { content: placeholderContent(shot) },
				},
				startTime: cursor,
			}),
			placement: { mode: "explicit", trackId: mainTrackId },
		});
		editor.command.execute({ command });

		links[command.getElementId()] = {
			shotId: shot.shotId,
			videoUrl: shot.videoUrl ?? null,
			videoSuffix: shot.videoSuffix ?? null,
			videoName: shot.videoName ?? null,
			shotNo: shot.shotNo ?? null,
		};

		cursor = addMediaTime({ a: cursor, b: duration });
	}

	return links;
}

/** "第1集 · 第3A场 · 镜2A" */
function shotLabel(shot: SaturnProjectShot): string {
	const view = projectShotViewLabel(shot);
	const shotNo = shot.shotNo ? `镜${shot.shotNo}` : "";
	return [view, shotNo].filter(Boolean).join(" · ") || `镜头 ${shot.shotId}`;
}

/**
 * What sits on screen where the picture will be: the shot's own description,
 * with dialogue appended when the shot has any — that is exactly the
 * information someone assembling a rough cut needs in front of them.
 */
function placeholderContent(shot: SaturnProjectShot): string {
	const parts = [shot.content, shot.videoDescription].filter(Boolean);
	if (shot.dialogue) parts.push(`【对白】${shot.dialogue}`);
	return parts.join("\n") || shotLabel(shot);
}
