/**
 * Longest edge of a stored thumbnail, in either orientation.
 *
 * The largest place a thumbnail is drawn is a 16:9 box about 116×65 CSS px
 * (a timeline tile on a video track; the asset grid card is 112×63), so 320
 * covers it at 2× DPR. Capping both edges at the same value keeps portrait
 * renders at 180×320 instead of 101×180, which would be visibly upscaled when
 * cropped to fill those boxes. Thumbnails are kept as data URLs in memory and
 * in IndexedDB for every asset, so anything larger is paid for hundreds of
 * times on a big project.
 */
const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_HEIGHT = 320;
const THUMBNAIL_JPEG_QUALITY = 0.6;

export function thumbnailSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } {
	const aspectRatio = width / height;
	let targetWidth = width;
	let targetHeight = height;

	if (targetWidth > THUMBNAIL_MAX_WIDTH) {
		targetWidth = THUMBNAIL_MAX_WIDTH;
		targetHeight = Math.round(targetWidth / aspectRatio);
	}
	if (targetHeight > THUMBNAIL_MAX_HEIGHT) {
		targetHeight = THUMBNAIL_MAX_HEIGHT;
		targetWidth = Math.round(targetHeight * aspectRatio);
	}

	return { width: targetWidth, height: targetHeight };
}

export function renderThumbnailDataUrl({
	width,
	height,
	draw,
}: {
	width: number;
	height: number;
	draw: ({
		context,
		width,
		height,
	}: {
		context: CanvasRenderingContext2D;
		width: number;
		height: number;
	}) => void;
}): string {
	const size = thumbnailSize({ width, height });
	const canvas = document.createElement("canvas");
	canvas.width = size.width;
	canvas.height = size.height;
	const context = canvas.getContext("2d");

	if (!context) {
		throw new Error("Could not get canvas context");
	}

	draw({ context, width: size.width, height: size.height });
	return canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY);
}
