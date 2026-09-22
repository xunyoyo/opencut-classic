import { projectShotViewLabel, type SaturnProjectShot } from "./types";

/** "第1集 · 第3A场 · 镜2A" */
export function shotLabel(shot: SaturnProjectShot): string {
	const view = projectShotViewLabel(shot);
	const shotNo = shot.shotNo ? `镜${shot.shotNo}` : "";
	return [view, shotNo].filter(Boolean).join(" · ") || `镜头 ${shot.shotId}`;
}

/**
 * A filename that says which shot this is, for the media library.
 *
 * AI-Saturn names its renders after an opaque object key
 * (`6a645bdb790b38771c9c1bab.mp4`), which tells a person nothing and makes the
 * media panel an unreadable wall of hashes. The shot's own labels — episode,
 * scene, shot number — are what someone picking a clip out of that panel is
 * actually looking for.
 */
export function shotFileName(shot: SaturnProjectShot): string {
	const base = shotLabel(shot).replace(/[\\/:*?"<>|]/g, "_");
	const suffix = (shot.videoSuffix ?? ".mp4").replace(/^\./, "");
	return `${base}.${suffix}`;
}
