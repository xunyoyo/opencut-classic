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
 * its children, which is the order they should land on a timeline.
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
