import { z } from "zod";
import type { SerializedProject } from "@/services/storage/types";

/**
 * What a snapshot must have for the restore path to be safe to attempt.
 *
 * Kept to `scenes` and `currentSceneId` — the two fields the restore reads
 * directly — while everything else passes through unvalidated, because the
 * editor owns those shapes and they change with `CURRENT_PROJECT_VERSION`.
 * Duplicating them here would mean a store that rejects tomorrow's snapshot.
 *
 * `scenes` is pinned to an array rather than left fully open so that a
 * truncated write producing a scalar there is rejected at read time instead of
 * exploding halfway through a restore. The *contents* of a scene are not
 * validated: `loadProject` in `services/storage/service.ts` reads the same
 * persisted scene shape and rebuilds it field by field without validating
 * either, and the two paths have to agree on what a stored scene is.
 *
 * `passthrough()` is load-bearing, not decoration. A plain `z.object` strips
 * unknown keys, so parsing a stored record would drop `metadata`, `settings`
 * and `timelineViewState` — and a restore would then quietly reset the user's
 * project settings and thumbnail to whatever the fallback happened to be.
 */
export const snapshotSchema = z
	.object({
		scenes: z.array(z.unknown()).optional(),
		currentSceneId: z.string().optional(),
	})
	.passthrough();

/**
 * The persisted shape of one saved engineering-file version.
 *
 * Deliberately NOT a field on `SerializedProject`. Version records are
 * auxiliary data: a project can exist with none, and deleting every version
 * must not touch the project record. Keeping them in their own store also
 * means this feature needs no project-schema migration at all — see the note
 * on `VERSION_DB_NAME` in `./store.ts`.
 */
export const projectVersionSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	/**
	 * Empty for an auto-snapshot or an unnamed manual save. The UI renders the
	 * timestamp in that case rather than us baking a formatted date into the
	 * field — a name that already looks like a timestamp cannot be told apart
	 * from one the user typed.
	 */
	name: z.string(),
	createdAt: z.number(),
	/**
	 * Whether this snapshot's content matches the project as it stands now.
	 *
	 * A flag on the record rather than a pointer on the project, which is what
	 * makes it survive "applied a version, then kept editing". With a pointer
	 * the project would have to nominate a version as current, and any edit
	 * after a restore would make that pointer a lie. A flag says only "this
	 * snapshot corresponds to the current content", which goes stale safely:
	 * the moment the user edits, no version claims to be current.
	 */
	isCurrent: z.boolean(),
	/**
	 * Media ids referenced by `snapshot`, collected at save time.
	 *
	 * Diagnostic only — nothing deletes by this list. In particular, deleting a
	 * version must never delete media: the bytes live in the project's single
	 * OPFS directory and every element references them by id, so a version's
	 * removal cannot orphan them, and another live version may still point at
	 * the same id.
	 */
	mediaIds: z.array(z.string()),
	/**
	 * `CURRENT_PROJECT_VERSION` at save time.
	 *
	 * Compared on read rather than migrated: a snapshot written by an older
	 * build may not lay out cleanly onto today's timeline, so it is shown but
	 * not applicable. Kept as a number so the eventual cross-version migration
	 * has something to branch on.
	 */
	appVersion: z.number(),
	/** True when written automatically (before a restore, or on exit). */
	isAuto: z.boolean(),
	/** The engineering file itself; see `snapshotSchema` for how much is pinned. */
	snapshot: snapshotSchema,
});

/**
 * The record as callers handle it.
 *
 * Wider than the schema's inferred output by design, and the width is not
 * invented: `SerializeProject` and `loadProject` treat a stored project as a
 * partly-trusted object and rebuild `TScene`s field by field. Typing this as
 * the schema output instead would push that same reconstruction onto every
 * consumer. The schema is what makes a record *admissible*; the type is what
 * the rest of the store works with once it is.
 */
export type ProjectVersion = Omit<
	z.infer<typeof projectVersionSchema>,
	"snapshot"
> & {
	snapshot: SerializedProject;
};

/**
 * One version as shown in the list.
 *
 * `snapshot` is dropped: the list needs a timestamp, a name, and two flags,
 * and carrying every scene of every version into render state would be the
 * largest object on the page for no benefit.
 */
export interface ProjectVersionSummary {
	id: string;
	projectId: string;
	name: string;
	createdAt: number;
	isCurrent: boolean;
	isAuto: boolean;
	appVersion: number;
	mediaCount: number;
}

/**
 * Why a version cannot be applied.
 *
 * Returned rather than thrown so the list can label the row and leave it
 * visible — a version the user cannot use is still something they should know
 * exists, and hiding it would read as data loss.
 */
export function getUnrecoverableReason({
	version,
	currentAppVersion,
}: {
	version: ProjectVersionSummary;
	currentAppVersion: number;
}): string | null {
	if (version.appVersion !== currentAppVersion) {
		return `该版本由旧版编辑器保存（v${version.appVersion}），当前为 v${currentAppVersion}，无法直接恢复`;
	}
	return null;
}

/**
 * Media references a snapshot depends on that are not `mediaId`-based.
 *
 * Library audio elements store an external `sourceUrl` instead of a media id
 * (`timeline/types.ts`), and that URL lives on a CDN we do not control. A
 * snapshot holding one is still restorable, but the sound may be gone by the
 * time it is restored, so the UI warns instead of blocking — blocking would
 * strand the user's actual edit over a sound effect.
 *
 * Takes `unknown` because it is defensive by nature and the caller may hold a
 * snapshot rejected or half-validated elsewhere; a narrower parameter would
 * only push an assertion up to the call site.
 */
export function hasExternalMediaReference({
	snapshot,
}: {
	snapshot: unknown;
}): boolean {
	let found = false;
	for (const scene of getSceneList({ snapshot })) {
		for (const track of getSceneTracks({ scene })) {
			for (const element of track.elements ?? []) {
				if (!isRecord(element)) continue;
				if (
					element.sourceType === "library" &&
					typeof element.sourceUrl === "string"
				) {
					found = true;
					break;
				}
			}
			if (found) break;
		}
		if (found) break;
	}
	return found;
}

/** Every media id a snapshot's elements point at. */
export function collectMediaIds({ snapshot }: { snapshot: unknown }): string[] {
	const ids = new Set<string>();
	for (const scene of getSceneList({ snapshot })) {
		for (const track of getSceneTracks({ scene })) {
			for (const element of track.elements ?? []) {
				if (!isRecord(element)) continue;
				if (typeof element.mediaId === "string" && element.mediaId.length > 0) {
					ids.add(element.mediaId);
				}
			}
		}
	}
	return [...ids];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSceneList({ snapshot }: { snapshot: unknown }): unknown[] {
	if (!isRecord(snapshot)) return [];
	return Array.isArray(snapshot.scenes) ? snapshot.scenes : [];
}

/**
 * Walks a scene's tracks without assuming the shape.
 *
 * Snapshots round-trip through IndexedDB and may predate a track-layout change,
 * so the walk is defensive: a missing `tracks` or a malformed track yields
 * nothing rather than throwing inside a render.
 */
function getSceneTracks({
	scene,
}: {
	scene: unknown;
}): Array<{ elements?: unknown[] }> {
	if (!isRecord(scene) || !isRecord(scene.tracks)) return [];
	const { tracks } = scene;
	const collected: Array<{ elements?: unknown[] }> = [];

	const main = tracks.main;
	if (isRecord(main) && Array.isArray(main.elements)) {
		collected.push({ elements: main.elements });
	}

	for (const key of ["overlay", "audio"] as const) {
		const list = tracks[key];
		if (!Array.isArray(list)) continue;
		for (const track of list) {
			if (isRecord(track) && Array.isArray(track.elements)) {
				collected.push({ elements: track.elements });
			}
		}
	}

	return collected;
}

export function toSummary({
	version,
}: {
	version: ProjectVersion;
}): ProjectVersionSummary {
	const { snapshot: _snapshot, mediaIds, ...rest } = version;
	return { ...rest, mediaCount: mediaIds.length };
}
