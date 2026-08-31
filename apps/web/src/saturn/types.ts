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
