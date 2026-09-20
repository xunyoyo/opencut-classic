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
