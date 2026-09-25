import type { SceneTracks } from "@/timeline";
import { getTrackTypeForElementType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	GroupMoveResult,
	MoveGroup,
	PlannedElementMove,
	PlannedTrackCreation,
} from "./types";
import {
	getDisplayTracks,
	getTrackPlacementByDisplayIndex,
	getTrackPlacementById,
} from "./track-placement";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type GroupMoveTarget =
	| {
			kind: "existingTrack";
			anchorTargetTrackId: string;
	  }
	| {
			kind: "newTracks";
			anchorInsertIndex: number;
			newTrackIds: string[];
	  };

export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	if (target.kind === "newTracks") {
		return resolveNewTrackMove({
			group,
			tracks,
			anchorStartTime,
			anchorInsertIndex: target.anchorInsertIndex,
			newTrackIds: target.newTrackIds,
		});
	}

	return resolveExistingTrackMove({
		group,
		tracks,
		anchorStartTime,
		anchorTargetTrackId: target.anchorTargetTrackId,
	});
}

function resolveExistingTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorTargetTrackId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorTargetTrackId: string;
}): GroupMoveResult | null {
	const anchorTargetPlacement = getTrackPlacementById({
		tracks,
		trackId: anchorTargetTrackId,
	});
	if (!anchorTargetPlacement) {
		return null;
	}

	const targetTrackIdsByElementId = resolveExistingTrackIdsByElementId({
		group,
		tracks,
		anchorTargetDisplayIndex: anchorTargetPlacement.displayIndex,
	});
	if (!targetTrackIdsByElementId) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId,
	});

	const moves = group.members.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdsByElementId.get(member.elementId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	if (!canApplyMovesToExistingTracks({ tracks, moves })) {
		return null;
	}

	return {
		moves,
		createTracks: [],
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function resolveNewTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorInsertIndex,
	newTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	anchorInsertIndex: number;
	newTrackIds: string[];
}): GroupMoveResult | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	if (sortedMembers.length === 0) {
		return null;
	}

	const hasAudioMember = sortedMembers.some(
		(member) => member.trackSection === "audio",
	);
	const hasNonAudioMember = sortedMembers.some(
		(member) => member.trackSection !== "audio",
	);
	if (hasAudioMember && hasNonAudioMember) {
		return null;
	}

	// One new track per *source* track, not per element. The members already
	// share a track and are dragged as a block, so giving each element its own
	// track would fan a single row of captions into a staircase. Ordered top to
	// bottom so the block keeps its internal layout and the anchor's position
	// within the block still determines where the block lands.
	const sortedSourceTrackIds = [
		...new Set(sortedMembers.map((member) => member.trackId)),
	].sort((leftTrackId, rightTrackId) => {
		const leftDisplayIndex = getTrackPlacementById({
			tracks,
			trackId: leftTrackId,
		})?.displayIndex;
		const rightDisplayIndex = getTrackPlacementById({
			tracks,
			trackId: rightTrackId,
		})?.displayIndex;
		return (leftDisplayIndex ?? 0) - (rightDisplayIndex ?? 0);
	});
	if (newTrackIds.length < sortedSourceTrackIds.length) {
		return null;
	}

	const anchorSourceTrackIndex = sortedSourceTrackIds.indexOf(
		group.anchor.trackId,
	);
	if (anchorSourceTrackIndex < 0) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByElementId: new Map(),
	});
	const blockStartIndex = hasAudioMember
		? clampAudioInsertIndex({
				tracks,
				insertIndex: anchorInsertIndex - anchorSourceTrackIndex,
			})
		: Math.max(
				0,
				Math.min(
					anchorInsertIndex - anchorSourceTrackIndex,
					tracks.overlay.length,
				),
			);

	// A source track's element type decides its new track's type; every member of
	// one track shares it, so any member will answer for it.
	const elementTypeBySourceTrackId = new Map(
		sortedMembers.map((member) => [member.trackId, member.elementType]),
	);
	const createTracks: PlannedTrackCreation[] = sortedSourceTrackIds.map(
		(sourceTrackId, sourceTrackIndex) => ({
			id: newTrackIds[sourceTrackIndex],
			type: getTrackTypeForElementType({
				elementType: elementTypeBySourceTrackId.get(sourceTrackId) ?? "video",
			}),
			index: blockStartIndex + sourceTrackIndex,
		}),
	);
	const targetTrackIdBySourceTrackId = new Map(
		sortedSourceTrackIds.map((sourceTrackId, sourceTrackIndex) => [
			sourceTrackId,
			newTrackIds[sourceTrackIndex],
		]),
	);
	const moves = sortedMembers.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdBySourceTrackId.get(member.trackId) ?? member.trackId,
		elementId: member.elementId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	return {
		moves,
		createTracks,
		targetSelection: moves.map(({ elementId, targetTrackId }) => ({
			trackId: targetTrackId,
			elementId,
		})),
	};
}

function clampAudioInsertIndex({
	tracks,
	insertIndex,
}: {
	tracks: SceneTracks;
	insertIndex: number;
}): number {
	const minimumAudioInsertIndex = tracks.overlay.length + 1;
	return Math.max(
		minimumAudioInsertIndex,
		Math.min(insertIndex, minimumAudioInsertIndex + tracks.audio.length),
	);
}

function resolveExistingTrackIdsByElementId({
	group,
	tracks,
	anchorTargetDisplayIndex,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorTargetDisplayIndex: number;
}): Map<string, string> | null {
	// A selection that already shares one track is a block, not a stack: the
	// members keep their relative offsets in time and their track never needs to
	// change. Handing each member its own track here is what turned a sideways
	// caption drag into a staircase of new text tracks, because a subtitle
	// timeline has exactly one text track and every "find me a free track" walk
	// therefore failed.
	const sharedSourceTrackId = resolveSharedSourceTrackId({ group });
	if (
		sharedSourceTrackId !== null &&
		getTrackPlacementById({ tracks, trackId: sharedSourceTrackId })
			?.displayIndex === anchorTargetDisplayIndex
	) {
		return new Map(
			group.members.map((member) => [member.elementId, sharedSourceTrackId]),
		);
	}

	const targetTrackIdsByElementId = new Map<string, string>();
	const usedTrackIds = new Set<string>();
	const anchorPlacement = getTrackPlacementByDisplayIndex({
		tracks,
		displayIndex: anchorTargetDisplayIndex,
	});
	if (!anchorPlacement) {
		return null;
	}

	// Members on differing source tracks move as a block: one vertical delta for
	// all of them, derived from the anchor's own travel. Letting each member grab
	// the nearest compatible track instead reorders them, so a selection spanning
	// two text tracks can collapse onto one, or swap.
	const anchorSourcePlacement = getTrackPlacementById({
		tracks,
		trackId: group.anchor.trackId,
	});
	if (!anchorSourcePlacement) {
		return null;
	}

	const displayIndexDelta =
		anchorTargetDisplayIndex - anchorSourcePlacement.displayIndex;
	for (const member of group.members) {
		const sourcePlacement = getTrackPlacementById({
			tracks,
			trackId: member.trackId,
		});
		if (!sourcePlacement) {
			return null;
		}

		const targetPlacement = getTrackPlacementByDisplayIndex({
			tracks,
			displayIndex: sourcePlacement.displayIndex + displayIndexDelta,
		});
		if (!targetPlacement) {
			return null;
		}

		const requiredTrackType = getTrackTypeForElementType({
			elementType: member.elementType,
		});
		if (targetPlacement.trackType !== requiredTrackType) {
			return null;
		}

		if (usedTrackIds.has(targetPlacement.trackId)) {
			return null;
		}

		targetTrackIdsByElementId.set(member.elementId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
	}

	return targetTrackIdsByElementId;
}

/**
 * The track every member starts on, or null when the selection spans more than
 * one. A shared source track is the common case for a caption block and lets the
 * move keep its tracks without any searching.
 */
function resolveSharedSourceTrackId({
	group,
}: {
	group: MoveGroup;
}): string | null {
	if (group.members.length === 0) {
		return null;
	}

	const [firstMember, ...otherMembers] = group.members;
	const sharedTrackId = firstMember.trackId;
	return otherMembers.some((member) => member.trackId !== sharedTrackId)
		? null
		: sharedTrackId;
}

function clampAnchorStartTime({
	group,
	tracks,
	anchorStartTime,
	targetTrackIdsByElementId,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	targetTrackIdsByElementId: Map<string, string>;
}): MediaTime {
	const minimumAnchorStartTime = group.members.reduce(
		(minimumStartTime, member) =>
			member.timeOffset < ZERO_MEDIA_TIME
				? maxMediaTime({
						a: minimumStartTime,
						b: subMediaTime({
							a: ZERO_MEDIA_TIME,
							b: member.timeOffset,
						}),
					})
				: minimumStartTime,
		ZERO_MEDIA_TIME,
	);
	let clampedAnchorStartTime =
		anchorStartTime < minimumAnchorStartTime
			? minimumAnchorStartTime
			: anchorStartTime;

	const memberOnMainTrack = group.members.find(
		(member) =>
			targetTrackIdsByElementId.get(member.elementId) === tracks.main.id,
	);
	if (!memberOnMainTrack) {
		return clampedAnchorStartTime;
	}

	const movingElementIds = new Set(
		group.members.map((member) => member.elementId),
	);
	const requestedMainStartTime = addMediaTime({
		a: clampedAnchorStartTime,
		b: memberOnMainTrack.timeOffset,
	});
	const earliestStationaryMainStartTime = tracks.main.elements
		.filter((element) => !movingElementIds.has(element.id))
		.reduce<MediaTime | null>((earliestStartTime, element) => {
			if (earliestStartTime == null || element.startTime < earliestStartTime) {
				return element.startTime;
			}

			return earliestStartTime;
		}, null);
	if (
		earliestStationaryMainStartTime == null ||
		requestedMainStartTime <= earliestStationaryMainStartTime
	) {
		clampedAnchorStartTime = maxMediaTime({
			a: minimumAnchorStartTime,
			b: subMediaTime({
				a: ZERO_MEDIA_TIME,
				b: memberOnMainTrack.timeOffset,
			}),
		});
	}

	return clampedAnchorStartTime;
}

function canApplyMovesToExistingTracks({
	tracks,
	moves,
}: {
	tracks: SceneTracks;
	moves: PlannedElementMove[];
}): boolean {
	const movingElementIds = new Set(moves.map((move) => move.elementId));
	const sourceElements = new Map(
		getDisplayTracks({ tracks }).flatMap((track) =>
			track.elements.map((element) => [element.id, element] as const),
		),
	);
	const movesByTargetTrackId = new Map<string, PlannedElementMove[]>();
	for (const move of moves) {
		const targetMoves = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		targetMoves.push(move);
		movesByTargetTrackId.set(move.targetTrackId, targetMoves);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetPlacement = getTrackPlacementById({
			tracks,
			trackId: targetTrackId,
		});
		if (!targetPlacement) {
			return false;
		}

		const targetTrack = getDisplayTracks({ tracks })[
			targetPlacement.displayIndex
		];
		if (!targetTrack) {
			return false;
		}

		const timeSpans = targetMoves.map((move) => {
			const sourceElement = sourceElements.get(move.elementId);
			return {
				startTime: move.newStartTime,
				duration: sourceElement?.duration ?? ZERO_MEDIA_TIME,
			};
		});
		if (hasOverlappingTimeSpans({ timeSpans })) {
			return false;
		}

		if (
			!canPlaceTimeSpansOnTrack({
				track: {
					elements: targetTrack.elements.filter(
						(element) => !movingElementIds.has(element.id),
					),
				},
				timeSpans,
			})
		) {
			return false;
		}
	}

	return true;
}

function hasOverlappingTimeSpans({
	timeSpans,
}: {
	timeSpans: Array<{ startTime: number; duration: number }>;
}): boolean {
	const sortedSpans = [...timeSpans].sort(
		(leftSpan, rightSpan) => leftSpan.startTime - rightSpan.startTime,
	);

	for (let spanIndex = 1; spanIndex < sortedSpans.length; spanIndex += 1) {
		const previousSpan = sortedSpans[spanIndex - 1];
		const currentSpan = sortedSpans[spanIndex];
		if (
			previousSpan.startTime + previousSpan.duration >
			currentSpan.startTime
		) {
			return true;
		}
	}

	return false;
}
