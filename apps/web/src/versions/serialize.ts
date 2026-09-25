import type { TProject } from "@/project/types";
// Imported from the module, not the `@/timeline` barrel: the barrel re-exports
// modules that reach `@/wasm`, which would make this file — and therefore the
// version store — unloadable under `bun test`.
import type { SceneTracks, TScene } from "@/timeline/types";
import type { TProjectMetadata } from "@/project/types";
import type {
	SerializedProject,
	SerializedProjectMetadata,
	SerializedScene,
} from "@/services/storage/types";
import type { MediaTime } from "@/wasm";

/**
 * The one thing this codec cannot do itself: total project duration.
 *
 * It sums `MediaTime` ticks through `addMediaTime` in `@/wasm`, and importing
 * that is exactly what would make the version store untestable. Rather than
 * reimplementing the rule here (two copies of a duration calculation that must
 * agree), the real implementation is injected at the call site.
 *
 * `@/wasm` is imported as a *type* only in this file, which erases at compile
 * time and pulls in nothing at runtime.
 */
export interface DurationMeasure {
	measureDuration({ scenes }: { scenes: TScene[] }): MediaTime;
}

/**
 * The main scene, or the first one when nothing is marked main.
 *
 * Pure, so the codec can decide *which* scene's duration matters without
 * needing the wasm call that computes it.
 */
export function getDurationSourceScene({
	scenes,
}: {
	scenes: TScene[];
}): TScene | null {
	const main = scenes.find((scene) => scene.isMain) ?? null;
	return main ?? scenes[0] ?? null;
}

/**
 * Sits outside `services/storage/service.ts` so the version store can snapshot
 * a project without importing that module, which reaches `@/wasm`.
 *
 * The media collection functions in `@/wasm` are the only wasm dependency in
 * the path, and the version list/CRUD has no use for them. Keeping the codec
 * here is what lets the store be exercised directly under `bun test`, where the
 * wasm bundle cannot load at all in this environment.
 */

/**
 * Audio elements carry a live `AudioBuffer`, which cannot be structured-cloned
 * into IndexedDB and is rebuilt from the media file on load. Stripped on the
 * way in for both the project record and a version snapshot.
 */
export function stripAudioBuffers({
	tracks,
}: {
	tracks: SceneTracks;
}): SceneTracks {
	return {
		...tracks,
		audio: tracks.audio.map((track) => ({
			...track,
			elements: track.elements.map((element) => {
				const { buffer: _buffer, ...rest } = element;
				return rest;
			}),
		})),
	};
}

/**
 * Enumerates every field by hand, so any new `TProjectMetadata` field must be
 * listed here or it is silently dropped on every save. `serializeProject` and
 * the rebuild in `service.ts` (`loadProject`/`loadAllProjectsMetadata`) share
 * this list and must be kept in sync.
 */
export function serializeProjectMetadata({
	metadata,
	duration,
}: {
	metadata: TProjectMetadata;
	duration: MediaTime;
}): SerializedProjectMetadata {
	return {
		id: metadata.id,
		name: metadata.name,
		thumbnail: metadata.thumbnail,
		duration,
		createdAt: metadata.createdAt.toISOString(),
		updatedAt: metadata.updatedAt.toISOString(),
		// Spread conditionally rather than writing the key explicitly — an
		// explicit `undefined` serializes into IndexedDB as null and would show
		// up on every locally-created project.
		...(metadata.saturnProjectId !== undefined && {
			saturnProjectId: metadata.saturnProjectId,
		}),
		...(metadata.saturnLaidOut !== undefined && {
			saturnLaidOut: metadata.saturnLaidOut,
		}),
	};
}

export function serializeScenes({
	scenes,
}: {
	scenes: TProject["scenes"];
}): SerializedScene[] {
	return scenes.map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: stripAudioBuffers({ tracks: scene.tracks }),
		bookmarks: scene.bookmarks,
		createdAt: scene.createdAt.toISOString(),
		updatedAt: scene.updatedAt.toISOString(),
	}));
}

/**
 * The one conversion from a live project to its stored form — the project
 * record and a version snapshot are byte-identical for the same input, which
 * is what makes a restored version indistinguishable from a saved project.
 *
 * `duration` is passed in rather than computed here so this file stays free of
 * `@/wasm`; see `DurationMeasure`.
 */
export function serializeProject({
	project,
	duration,
}: {
	project: TProject;
	duration: MediaTime;
}): SerializedProject {
	return {
		metadata: serializeProjectMetadata({
			metadata: project.metadata,
			duration,
		}),
		scenes: serializeScenes({ scenes: project.scenes }),
		currentSceneId: project.currentSceneId,
		settings: project.settings,
		version: project.version,
		timelineViewState: project.timelineViewState,
	};
}
