import type { TProjectSettings } from "@/project/types";
import { floatToFrameRate } from "@/fps/utils";

/**
 * Project-settings changes triggered by the first visual clip landing on an
 * empty timeline, split by whether they apply immediately. Kept pure so the
 * locked-canvas rule is testable without an editor.
 *
 * The canvas follows the first clip's pixel size, except when AI-Saturn fixed
 * the canvas (`saturnCanvasLock`): then the ratio the user chose on the
 * platform wins over whatever the first footage happens to be. The frame rate
 * still follows the footage either way.
 */
export function resolveFirstMediaSettings({
	settings,
	asset,
}: {
	settings: Pick<
		TProjectSettings,
		"originalCanvasSize" | "saturnCanvasLock"
	> | null;
	asset:
		| { type?: string; width?: number; height?: number; fps?: number }
		| undefined;
}): {
	canvas: Partial<TProjectSettings> | null;
	fps: Partial<TProjectSettings> | null;
} {
	const canvas =
		!settings?.saturnCanvasLock && asset?.width && asset?.height
			? (() => {
					const nextCanvasSize = { width: asset.width, height: asset.height };
					return {
						canvasSize: nextCanvasSize,
						...(!settings?.originalCanvasSize
							? { originalCanvasSize: nextCanvasSize }
							: {}),
					};
				})()
			: null;

	const fps =
		asset?.type === "video" && asset.fps
			? { fps: floatToFrameRate(asset.fps) }
			: null;

	return { canvas, fps };
}
