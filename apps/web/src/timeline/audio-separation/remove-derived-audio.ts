import type { SceneTracks, TimelineElement } from "@/timeline/types";

/**
 * Drop every audio element that was derived from `sourceElementId`.
 *
 * Matching is pointer-only, never `mediaId` + `startTime`: a user is free to
 * place a second copy of the same asset at the same offset, and inferring
 * ownership from those two fields would silently delete their element. Elements
 * separated before `derivedFromElementId` existed carry no pointer and are
 * therefore left alone — that limitation is preferable to data loss.
 */
export function removeDerivedAudioElements({
	tracks,
	sourceElementId,
}: {
	tracks: SceneTracks;
	sourceElementId: string;
}): SceneTracks {
	return {
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.filter(
				(element) => !isDerivedFrom({ element, sourceElementId }),
			),
		})),
	};
}

/**
 * True for elements this module owns. Exported so the recovery branch and the
 * timeline context menu can share one definition of "derived".
 */
export function isDerivedFrom({
	element,
	sourceElementId,
}: {
	element: TimelineElement;
	sourceElementId: string;
}): boolean {
	return (
		element.type === "audio" &&
		element.sourceType === "upload" &&
		element.derivedFromElementId === sourceElementId
	);
}
