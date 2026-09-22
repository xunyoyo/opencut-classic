import { z } from "zod";

/**
 * The slice of AI-Saturn's API surface that the importer depends on.
 *
 * Upstream types live in `saturndf-project` as `ShotListDto` (which extends
 * `ShotList`) and `Attachment`. Almost everything is nullable here because the
 * upstream DTO is filled in progressively across generation stages — a shot
 * that has not been rendered yet carries no video attachment, and a shot with
 * no spoken lines carries no dialogue.
 *
 * Parsed rather than cast: this is data crossing a network boundary from a
 * separate codebase, and the fields we depend on are exactly the ones that go
 * missing when a shot is only half-generated.
 */

export const saturnAttachmentSchema = z.object({
	name: z.string().nullish(),
	suffix: z.string().nullish(),
	size: z.number().nullish(),
	/** Absolute CDN URL of the stored file. */
	storePath: z.string().nullish(),
});

export const saturnShotSchema = z.object({
	shotId: z.number(),
	/** Shot number as authored, e.g. "1", "2A". Not necessarily numeric. */
	shotNo: z.string().nullish(),
	/** Planned duration in seconds. The rendered video may differ. */
	duration: z.number().nullish(),
	content: z.string().nullish(),
	dialogue: z.string().nullish(),
	video: saturnAttachmentSchema.nullish(),
});

/** RuoYi wraps every response in `AjaxResult`, a `{ code, msg, data }` map. */
export const saturnShotListResponseSchema = z.object({
	code: z.number(),
	msg: z.string(),
	data: z.array(saturnShotSchema).nullish(),
});

export type SaturnAttachment = z.infer<typeof saturnAttachmentSchema>;
export type SaturnShot = z.infer<typeof saturnShotSchema>;

/** A shot that passed the "has a downloadable video" filter. */
export interface RenderedShot extends SaturnShot {
	video: SaturnAttachment & { storePath: string };
}

// Positional parameter rather than the codebase's usual object argument:
// TypeScript rejects a type predicate that names a destructured binding
// (TS1230), and the narrowing is the point of this helper.
export function hasRenderedVideo(shot: SaturnShot): shot is RenderedShot {
	return (
		typeof shot.video?.storePath === "string" &&
		shot.video.storePath.startsWith("http")
	);
}

// ---------------------------------------------------------------------------
// Project + view (场次) types — used by the project/view selector UI
// ---------------------------------------------------------------------------

/**
 * Minimal slice of AI-Saturn's ProjectInfo that the selector needs.
 * Upstream entity: `com.saturndf.project.domain.entity.ProjectInfo`.
 */
export const saturnProjectSchema = z.object({
	projectId: z.number(),
	projectName: z.string(),
	/** 1: 剧集, 2: 电影, 3: 漫剧, 99: 其他 */
	type: z.number().nullish(),
	logo: z.string().nullish(),
	summary: z.string().nullish(),
});

export const saturnProjectListResponseSchema = z.object({
	code: z.number(),
	msg: z.string(),
	/** RuoYi TableDataInfo wraps the list in `rows`. */
	rows: z.array(saturnProjectSchema).nullish(),
	/** Some endpoints put the list directly in `data`. */
	data: z.array(saturnProjectSchema).nullish(),
});

export type SaturnProject = z.infer<typeof saturnProjectSchema>;

/**
 * Minimal slice of AI-Saturn's ViewInfo needed by the selector.
 * Upstream entity: `com.saturndf.project.domain.entity.ViewInfo`.
 */
export const saturnViewSchema = z.object({
	viewId: z.number(),
	/** Episode number, e.g. 1, 2. */
	seriesNo: z.number().nullish(),
	/** Scene number within episode, e.g. 3. */
	viewNo: z.number().nullish(),
	/** Free-form suffix like "A", "B". */
	viewNoSurffix: z.string().nullish(),
	mainContent: z.string().nullish(),
	site: z.string().nullish(),
	/** 0: unfinished, 1: partial, 2: done, 3: deleted */
	shootStatus: z.number().nullish(),
});

export type SaturnView = z.infer<typeof saturnViewSchema>;

/**
 * LoadViewRespVo has a `list` field of LoadViewListRespVo, each of which holds
 * a `viewList`. We surface only the fields the selector actually needs.
 */
export const saturnLoadViewRespVoSchema = z.object({
	viewId: z.number(),
	seriesNo: z.number().nullish(),
	viewNo: z.number().nullish(),
	viewNoSurffix: z.string().nullish(),
	mainContent: z.string().nullish(),
	site: z.string().nullish(),
	shootStatus: z.number().nullish(),
});

export const saturnViewListResponseSchema = z.object({
	code: z.number(),
	msg: z.string(),
	data: z
		.object({
			list: z
				.array(
					z.object({
						viewList: z.array(saturnLoadViewRespVoSchema).nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

// ---------------------------------------------------------------------------
// Project-wide shot metadata — the one-shot prefetch that backs /saturn-open
// ---------------------------------------------------------------------------

/**
 * Mirrors the backend's `ProjectShotDto`.
 *
 * This deliberately carries no media bytes: the whole point is that a project's
 * structure is a few hundred KB of JSON while its shots are tens of GB, so the
 * editor prefetches the former and pulls the latter per clip on demand. The
 * `videoUrl` here is the CDN address to hand to `/api/saturn/asset`.
 */
export interface SaturnProjectShot {
	shotId: number;
	viewId?: number | null;
	seriesNo?: number | null;
	viewNo?: number | null;
	viewNoSurffix?: string | null;
	shotNo?: string | null;
	/** Planned duration in seconds — may disagree with the rendered video. */
	duration?: number | null;
	content?: string | null;
	dialogue?: string | null;
	videoDescription?: string | null;
	shotSize?: string | null;
	cameraMovement?: string | null;
	angle?: string | null;
	site?: string | null;
	transition?: string | null;
	soundEffect?: string | null;
	videoUrl?: string | null;
	videoSuffix?: string | null;
	videoName?: string | null;
	firstFrameId?: number | null;
	lastFrameId?: number | null;
	type?: number | null;
	parentShotId?: number | null;
	subShots?: SaturnProjectShot[] | null;
}

// Annotated rather than inferred: the schema refers to itself through
// `subShots`, which TypeScript cannot infer without the explicit type argument.
export const saturnProjectShotSchema: z.ZodType<SaturnProjectShot> = z.object({
	shotId: z.number(),
	viewId: z.number().nullish(),
	seriesNo: z.number().nullish(),
	viewNo: z.number().nullish(),
	viewNoSurffix: z.string().nullish(),
	shotNo: z.string().nullish(),
	duration: z.number().nullish(),
	content: z.string().nullish(),
	dialogue: z.string().nullish(),
	videoDescription: z.string().nullish(),
	shotSize: z.string().nullish(),
	cameraMovement: z.string().nullish(),
	angle: z.string().nullish(),
	site: z.string().nullish(),
	transition: z.string().nullish(),
	soundEffect: z.string().nullish(),
	videoUrl: z.string().nullish(),
	videoSuffix: z.string().nullish(),
	videoName: z.string().nullish(),
	firstFrameId: z.number().nullish(),
	lastFrameId: z.number().nullish(),
	type: z.number().nullish(),
	parentShotId: z.number().nullish(),
	get subShots() {
		return z.array(saturnProjectShotSchema).nullish();
	},
});

export const saturnProjectShotsResponseSchema = z.object({
	code: z.number(),
	msg: z.string(),
	data: z.array(saturnProjectShotSchema).nullish(),
});

/** True when the shot has a rendered video the editor can actually download. */
export function hasProjectShotVideo(
	shot: SaturnProjectShot,
): shot is SaturnProjectShot & { videoUrl: string } {
	return (
		typeof shot.videoUrl === "string" && shot.videoUrl.startsWith("http")
	);
}

/**
 * Depth-first flatten of the shot tree.
 *
 * The backend returns sub-shots nested under their parent, so counting the
 * top-level array undercounts. Order is preserved: a parent is emitted before
 * its children.
 *
 * This is the "what shots exist" walk, used for counts. For which shots carry a
 * stretch of picture, see projectShotSegments — the two differ by the containers.
 */
export function flattenProjectShots(
	shots: SaturnProjectShot[],
): SaturnProjectShot[] {
	const flat: SaturnProjectShot[] = [];
	const walk = (list: SaturnProjectShot[]) => {
		for (const shot of list) {
			flat.push(shot);
			if (shot.subShots?.length) walk(shot.subShots);
		}
	};
	walk(shots);
	return flat;
}

/**
 * The shots that are each one segment of picture, in play order.
 *
 * One rule: a shot that has a rendered video is a segment, and a segment is
 * exactly one stretch of picture. Nothing else qualifies — a shot with no
 * render is not a segment, because nothing is placed on the timeline from this
 * list. The editor hands the user a filled assets panel and leaves the timeline
 * to them; the segments exist to say which shots have footage worth importing.
 * The same predicate therefore does double duty: segments are what gets
 * downloaded, and what the caller counts when it needs to know whether a
 * project has any footage at all.
 *
 * The parent/child structure matters for exactly one reason: not counting the
 * same stretch of picture twice. A shot with sub-shots is one prompt of up to
 * ~15s written as a parent row plus the frames inside it, and the children's
 * durations sum to the parent's
 * (`AI-Saturn-AI-ability/app/models/storyboard.py`, `_validate_timecode_alignment`).
 * AI-Saturn renders that prompt either as one video on the parent (分镜模式) or
 * as one video per child (快捷模式, the default) — never both. So descending
 * into the children only when the parent has no video picks the level that
 * actually carries the picture, and a parent that has one is left as a single
 * 15s segment instead of three stubs.
 *
 * A container whose sub-shots are all unrendered still comes back as a
 * segment: the recursion finds no render to descend to, so the parent is what
 * gets pushed. This is a superset filter by structure, not by render — every
 * consumer filters on `videoUrl` itself, and only takes this list as "which
 * shots to consider".
 *
 * Exists alongside flattenProjectShots because they answer different questions:
 * that one is "what shots exist" (counts, the API contract), this is "which
 * shots carry a stretch of picture".
 */
export function projectShotSegments(
	shots: SaturnProjectShot[],
): SaturnProjectShot[] {
	const segments: SaturnProjectShot[] = [];
	const walk = (list: SaturnProjectShot[]) => {
		for (const shot of list) {
			if (shot.subShots?.length && !hasProjectShotVideo(shot)) {
				walk(shot.subShots);
			} else {
				segments.push(shot);
			}
		}
	};
	walk(shots);
	return segments;
}

/** "第1集 · 第3A场" — the label AI-Saturn itself shows for a 场次. */
export function projectShotViewLabel(shot: SaturnProjectShot): string {
	const episode = shot.seriesNo != null ? `第${shot.seriesNo}集` : "";
	const scene =
		shot.viewNo != null
			? `第${shot.viewNo}${shot.viewNoSurffix ?? ""}场`
			: shot.viewId != null
				? `场次 ${shot.viewId}`
				: "";
	return [episode, scene].filter(Boolean).join(" · ");
}
