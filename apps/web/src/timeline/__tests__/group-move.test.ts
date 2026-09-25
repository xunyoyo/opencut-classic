import { describe, expect, test } from "bun:test";

import type {
	SceneTracks,
	TextElement,
	TextTrack,
	TrackType,
	VideoTrack,
} from "@/timeline";
import type { MoveGroup } from "@/timeline/group-move/types";

/**
 * Statically imported, not dynamically: these used to be `await import`ed
 * because a `mock.module("@/wasm", ...)` in this file had to be registered
 * before they were evaluated. The vendored wasm package is stubbed once for the
 * whole suite through `bunfig.toml`'s preload instead, so nothing here depends
 * on load order any more.
 */
import { buildMoveGroup } from "@/timeline/group-move/build-group";
import { resolveGroupMove } from "@/timeline/group-move/resolve-move";
import { mediaTime } from "@/wasm";

function buildTextElement({
	id,
	startTime,
	duration,
}: {
	id: string;
	startTime: number;
	duration: number;
}): TextElement {
	return {
		id,
		type: "text",
		name: id,
		startTime: mediaTime({ ticks: startTime }),
		duration: mediaTime({ ticks: duration }),
		trimStart: mediaTime({ ticks: 0 }),
		trimEnd: mediaTime({ ticks: 0 }),
		params: { content: id },
	};
}

function buildTextTrack({
	id,
	elements = [],
}: {
	id: string;
	elements?: TextElement[];
}): TextTrack {
	return { id, type: "text", name: id, hidden: false, elements };
}

function buildMainTrack(): VideoTrack {
	return {
		id: "video-main",
		type: "video",
		name: "main",
		muted: false,
		hidden: false,
		elements: [],
	};
}

function buildSceneTracks({ overlay }: { overlay: TextTrack[] }): SceneTracks {
	return { overlay, main: buildMainTrack(), audio: [] };
}

/** Ten captions on a single text track — the shape the caption importer produces. */
function buildCaptionTrack(): TextTrack {
	return buildTextTrack({
		id: "text-1",
		elements: Array.from({ length: 10 }, (_, index) =>
			buildTextElement({
				id: `c${index}`,
				startTime: index * 10,
				duration: 8,
			}),
		),
	});
}

function buildCaptionRefs(): Array<{ trackId: string; elementId: string }> {
	return Array.from({ length: 10 }, (_, index) => ({
		trackId: "text-1",
		elementId: `c${index}`,
	}));
}

function buildGroup({
	tracks,
	anchorElementId,
	selection,
}: {
	tracks: SceneTracks;
	anchorElementId: string;
	selection: Array<{ trackId: string; elementId: string }>;
}): MoveGroup {
	const group = buildMoveGroup({
		anchorRef: { trackId: "text-1", elementId: anchorElementId },
		selectedElements: selection,
		tracks,
	});
	if (!group) {
		throw new Error("failed to build the move group fixture");
	}

	return group;
}

function buildNewTrackIds({ count }: { count: number }): string[] {
	return Array.from({ length: count }, (_, index) => `new-${index}`);
}

describe("resolveGroupMove on a single shared track", () => {
	test("dragging a whole caption track sideways keeps every element on that track", () => {
		// The customer's gesture: every caption lives on one text track, all of
		// them are selected, and the drag is lateral. Nothing about it should
		// change a track, so no track may be created and every target must be the
		// source track. The old implementation returned null here and the
		// controller fell back to minting one new track per caption.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: 5 }),
			target: { kind: "existingTrack", anchorTargetTrackId: "text-1" },
		});

		expect(result).not.toBeNull();
		expect(result?.createTracks).toHaveLength(0);
		expect(result?.moves).toHaveLength(10);
		for (const move of result?.moves ?? []) {
			expect(move.targetTrackId).toBe("text-1");
		}
		// A lateral drag shifts the block by one delta and preserves spacing.
		expect(result?.moves.map((move) => move.newStartTime)).toEqual(
			Array.from({ length: 10 }, (_, index) =>
				mediaTime({ ticks: 5 + index * 10 }),
			),
		);
	});

	test("a lateral drag onto the same track is not blocked by the elements sitting under it", () => {
		// The members occupy the same track they are leaving, so the overlap check
		// must compare them against the stationary elements only. A block shifted
		// by a non-multiple of the caption pitch would otherwise collide with
		// itself and be rejected.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: 3 }),
			target: { kind: "existingTrack", anchorTargetTrackId: "text-1" },
		});

		expect(result?.createTracks).toHaveLength(0);
		expect(result?.moves.map((move) => move.newStartTime)).toEqual(
			Array.from({ length: 10 }, (_, index) =>
				mediaTime({ ticks: 3 + index * 10 }),
			),
		);
	});

	test("a negative drop time is clamped so the earliest caption starts at zero", () => {
		// The caller clamps the anchor, never the individual members, so the
		// block keeps its internal spacing and simply stops at the origin.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: -30 }),
			target: { kind: "existingTrack", anchorTargetTrackId: "text-1" },
		});

		expect(result?.moves[0].newStartTime).toBe(mediaTime({ ticks: 0 }));
		expect(result?.moves[1].newStartTime).toBe(mediaTime({ ticks: 10 }));
	});

	test("a single caption dragged within its own track still moves alone", () => {
		// The one-element case works today; a fix must not regress it.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c3",
			selection: [{ trackId: "text-1", elementId: "c3" }],
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: 30 }),
			target: { kind: "existingTrack", anchorTargetTrackId: "text-1" },
		});

		expect(result?.createTracks).toHaveLength(0);
		expect(result?.moves).toHaveLength(1);
		expect(result?.moves[0].targetTrackId).toBe("text-1");
		expect(result?.moves[0].newStartTime).toBe(mediaTime({ ticks: 30 }));
	});
});

describe("resolveGroupMove when no existing track can hold the block", () => {
	test("the fallback allocates one track for the whole block, not one per member", () => {
		// Reached when the pointer is over empty space. The block still occupies a
		// single row afterwards, so exactly one track is created and every member
		// lands on it. Minting ten tracks here is what produced the staircase.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: 100 }),
			target: {
				kind: "newTracks",
				anchorInsertIndex: 0,
				newTrackIds: buildNewTrackIds({ count: 10 }),
			},
		});

		expect(result?.createTracks).toHaveLength(1);
		expect(result?.createTracks[0].type).toBe("text" satisfies TrackType);
		expect(result?.moves).toHaveLength(10);
		expect(new Set(result?.moves.map((move) => move.targetTrackId))).toEqual(
			new Set(["new-0"]),
		);
		// The element order is preserved by start time.
		expect(result?.moves.map((move) => move.newStartTime)).toEqual(
			Array.from({ length: 10 }, (_, index) =>
				mediaTime({ ticks: 100 + index * 10 }),
			),
		);
	});

	test("a block spanning two source tracks keeps its two rows", () => {
		// Two captions tracks dragged together must not collapse onto one track
		// (the elements would overlap in time) nor fan out to two tracks each.
		const tracks = buildSceneTracks({
			overlay: [
				buildTextTrack({
					id: "text-1",
					elements: [
						buildTextElement({ id: "c0", startTime: 0, duration: 8 }),
						buildTextElement({ id: "c1", startTime: 10, duration: 8 }),
					],
				}),
				buildTextTrack({
					id: "text-2",
					elements: [
						buildTextElement({ id: "d0", startTime: 0, duration: 8 }),
						buildTextElement({ id: "d1", startTime: 10, duration: 8 }),
					],
				}),
			],
		});
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: [
				{ trackId: "text-1", elementId: "c0" },
				{ trackId: "text-1", elementId: "c1" },
				{ trackId: "text-2", elementId: "d0" },
				{ trackId: "text-2", elementId: "d1" },
			],
		});

		const result = resolveGroupMove({
			group,
			tracks,
			anchorStartTime: mediaTime({ ticks: 100 }),
			target: {
				kind: "newTracks",
				anchorInsertIndex: 0,
				newTrackIds: buildNewTrackIds({ count: 4 }),
			},
		});

		expect(result?.createTracks).toHaveLength(2);
		const targetByElementId = new Map(
			result?.moves.map((move) => [move.elementId, move.targetTrackId]),
		);
		// The two rows stay distinct and the members of each row stay together.
		expect(targetByElementId.get("c0")).toBe(targetByElementId.get("c1"));
		expect(targetByElementId.get("d0")).toBe(targetByElementId.get("d1"));
		expect(targetByElementId.get("c0")).not.toBe(targetByElementId.get("d0"));
	});
});

describe("resolveGroupMove rejects moves it cannot honour", () => {
	test("returns null when the block would overlap an element left behind", () => {
		// `c4` stays put at 40-48; dropping the block there must fail so the
		// caller falls back rather than stacking two captions on one track.
		const tracks = buildSceneTracks({
			overlay: [
				buildTextTrack({
					id: "text-1",
					elements: [
						buildTextElement({ id: "c3", startTime: 30, duration: 8 }),
						buildTextElement({ id: "c4", startTime: 40, duration: 8 }),
					],
				}),
			],
		});
		const group = buildGroup({
			tracks,
			anchorElementId: "c3",
			selection: [{ trackId: "text-1", elementId: "c3" }],
		});

		expect(
			resolveGroupMove({
				group,
				tracks,
				anchorStartTime: mediaTime({ ticks: 35 }),
				target: { kind: "existingTrack", anchorTargetTrackId: "text-1" },
			}),
		).toBeNull();
	});

	test("returns null when the drop target track does not exist", () => {
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		expect(
			resolveGroupMove({
				group,
				tracks,
				anchorStartTime: mediaTime({ ticks: 0 }),
				target: { kind: "existingTrack", anchorTargetTrackId: "missing" },
			}),
		).toBeNull();
	});

	test("returns null when the fallback is given too few reserved track ids", () => {
		// The controller reserves one id per member; a block spanning two source
		// tracks needs two. Anything less is a programming error, not a move.
		const tracks = buildSceneTracks({ overlay: [buildCaptionTrack()] });
		const group = buildGroup({
			tracks,
			anchorElementId: "c0",
			selection: buildCaptionRefs(),
		});

		expect(
			resolveGroupMove({
				group,
				tracks,
				anchorStartTime: mediaTime({ ticks: 0 }),
				target: {
					kind: "newTracks",
					anchorInsertIndex: 0,
					newTrackIds: [],
				},
			}),
		).toBeNull();
	});
});
