import type { TProjectSettings } from "@/project/types";

/**
 * How a visual source is sized against the canvas before the user's own
 * scale is applied.
 *
 * - `contain`: the whole source is visible; the short side leaves bars.
 *   This is the editor's long-standing behaviour and the default.
 * - `cover`: the canvas is filled; the overflow is cropped.
 */
export type VisualFit = "contain" | "cover";

/**
 * The factor that takes the source's pixel size to its fitted size on the
 * canvas. Shared by the renderer (preview and export both go through it) and
 * by the selection-box geometry, so the two can never disagree.
 */
export function getFitScale({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	fit = "contain",
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	fit?: VisualFit;
}): number {
	const widthRatio = canvasWidth / sourceWidth;
	const heightRatio = canvasHeight / sourceHeight;
	return fit === "cover"
		? Math.max(widthRatio, heightRatio)
		: Math.min(widthRatio, heightRatio);
}

/**
 * Fit mode for video clips in a project.
 *
 * A project whose canvas was fixed by AI-Saturn (`saturnCanvasLock`) fills the
 * frame with its video; every other project keeps `contain`. Images, text and
 * stickers are unaffected either way.
 */
export function getVideoFit({
	settings,
}: {
	settings: Pick<TProjectSettings, "saturnCanvasLock"> | null | undefined;
}): VisualFit {
	return settings?.saturnCanvasLock ? "cover" : "contain";
}
