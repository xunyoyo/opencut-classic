import type { MediaAsset } from "@/media/types";

/**
 * Inserts `asset` into `assets` at `index`, clamped to the list's bounds.
 *
 * Undo and redo of the media commands put back or take out only their own
 * asset, in the list as it is *now*. Restoring a copy of the whole list taken
 * when the command ran would also roll back everything that changed since:
 * an asset another command of the same batch has put back with a fresh URL
 * would return with its revoked one, an asset a background import has since
 * swapped onto its stored file would get its heap copy back, and assets
 * imported in the meantime would vanish.
 */
export function insertMediaAssetAt({
	assets,
	asset,
	index,
}: {
	assets: MediaAsset[];
	asset: MediaAsset;
	index: number;
}): MediaAsset[] {
	const at = Math.min(Math.max(index, 0), assets.length);
	return [...assets.slice(0, at), asset, ...assets.slice(at)];
}
