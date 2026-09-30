import type { MediaType } from "@/media/types";

/**
 * Gives an SVG read back from OPFS its MIME type back.
 *
 * OPFS keeps the bytes but not the type, so every file read back from it has
 * an empty `type`. Browsers sniff raster images, video and audio behind an
 * untyped blob URL, but will not render an SVG without `image/svg+xml`.
 *
 * The type goes onto the `File` rather than only onto the URL minted at load
 * time: an asset's URL is minted again from its `file` later on (undoing its
 * removal does), and that URL has to render as well.
 */
export async function restoreStoredMediaFileType({
	file,
	type,
}: {
	file: File;
	type: MediaType;
}): Promise<File> {
	if (type !== "image" || file.type) return file;

	try {
		// Only the head is read: this runs for every stored image on every
		// project load and import, and a raster photo read whole just to be
		// told apart from an SVG would briefly put all of it on the heap.
		const head = await file.slice(0, SVG_SNIFF_BYTES).text();
		if (!(await looksLikeSvg({ file, head }))) return file;

		// Wrapping keeps the bytes on disk; only the type is new.
		return new File([file], file.name, {
			type: "image/svg+xml",
			lastModified: file.lastModified,
		});
	} catch {
		return file;
	}
}

const SVG_SNIFF_BYTES = 4096;
/** How far into a markup file to look for a root past a long prologue. */
const SVG_PROLOGUE_MAX_BYTES = 256 * 1024;

/**
 * An SVG root, allowing for what editors put in front of it: a byte-order
 * mark, an XML declaration, comments and a DOCTYPE (Illustrator and Inkscape
 * exports start with these, not with `<svg`).
 */
const SVG_PROLOGUE_REGEX =
	/^\uFEFF?\s*(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)*<svg[\s>/]/i;

async function looksLikeSvg({
	file,
	head,
}: {
	file: File;
	head: string;
}): Promise<boolean> {
	if (SVG_PROLOGUE_REGEX.test(head)) return true;
	// A prologue longer than the sniffed head (a long licence comment). Only
	// markup starts with "<", never a raster format, so reading further is
	// confined to files that are text anyway.
	if (!/^\uFEFF?\s*</.test(head) || head.includes("\u0000")) return false;
	const prologue = await file.slice(0, SVG_PROLOGUE_MAX_BYTES).text();
	return SVG_PROLOGUE_REGEX.test(prologue);
}
