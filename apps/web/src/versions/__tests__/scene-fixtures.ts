/**
 * Builders for the two scene shapes the version codec moves between.
 *
 * `SerializedScene` (seconds-as-ISO-strings, plain objects) and `TScene` (live,
 * with `Date`s) are genuinely different types, so they get different builders:
 * conflating them hid a real mistake in an earlier draft of these tests.
 *
 * Written with explicit field lists rather than `as` casts where practical, so
 * a fixture that no longer matches the real types fails to compile rather than
 * being coerced into passing. The repo's lint config makes every assertion an
 * error, which is the point: the one remaining conversion lives in `tick()`
 * below, where it is explained.
 */
import type { SerializedScene } from "@/services/storage/types";
import type { SceneTracks, TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

/**
 * `MediaTime` is a branded integer, so a bare literal is not assignable to it
 * and the repo forbids the narrowing assertion that would bridge that. These
 * values genuinely are integer tick counts — which is exactly what the brand
 * asserts — so one conversion at the top of the fixtures keeps the rest of the
 * file honest. Same pattern as `timeline/time-range/__tests__/store.test.ts`.
 */
export function tick({ value }: { value: number }): MediaTime {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded MediaTime over a tick count, see above
	return value as MediaTime;
}

export function buildSceneTracks({
	mainMediaIds = [] as string[],
}: {
	mainMediaIds?: string[];
} = {}): SceneTracks {
	return {
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: mainMediaIds.map((mediaId, index) => ({
				id: `element-${index}`,
				type: "video" as const,
				name: `Video ${index}`,
				mediaId,
				startTime: tick({ value: 0 }),
				duration: tick({ value: 100 }),
				trimStart: tick({ value: 0 }),
				trimEnd: tick({ value: 0 }),
				params: {},
			})),
		},
		overlay: [],
		audio: [],
	};
}

export function buildScene({
	id = "scene-1",
	tracks,
}: {
	id?: string;
	tracks?: SceneTracks;
} = {}): SerializedScene {
	return {
		id,
		name: "主场景",
		isMain: true,
		tracks: tracks ?? buildSceneTracks(),
		bookmarks: [],
		createdAt: "2024-01-01T00:00:00.000Z",
		updatedAt: "2024-01-01T00:00:00.000Z",
	};
}

/** A live scene, as the editor holds it — `Date`s, not ISO strings. */
export function buildLiveScene({
	id = "scene-1",
	mainMediaIds = [] as string[],
}: {
	id?: string;
	mainMediaIds?: string[];
} = {}): TScene {
	return {
		id,
		name: "主场景",
		isMain: true,
		tracks: buildSceneTracks({ mainMediaIds }),
		bookmarks: [],
		createdAt: new Date("2024-01-01T00:00:00.000Z"),
		updatedAt: new Date("2024-01-02T00:00:00.000Z"),
	};
}
