import { z } from "zod";
import {
	saturnProjectShotSchema,
	saturnProjectShotsResponseSchema,
	type SaturnProjectShot,
} from "./types";

/**
 * Fetches every shot in the caller's current AI-Saturn project.
 *
 * Note this is the *whole* project, across all episodes and scenes: the
 * upstream endpoint reads the project from the session rather than taking an
 * id. That is what makes a single request enough to populate the editor.
 */
export async function fetchSaturnProjectShots({
	token,
	signal,
}: {
	token: string;
	signal?: AbortSignal;
}): Promise<SaturnProjectShot[]> {
	const response = await fetch("/api/saturn/project-shots", {
		headers: { Authorization: token },
		signal,
	});

	if (response.status === 401) {
		throw new Error("AI-Saturn 登录态已失效，请重新从平台进入");
	}
	if (!response.ok) {
		throw new Error(`获取项目分镜失败（HTTP ${response.status}）`);
	}

	const parsed = saturnProjectShotsResponseSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success) {
		throw new Error("AI-Saturn 返回了无法解析的分镜数据");
	}
	if (parsed.data.code !== 200) {
		throw new Error(parsed.data.msg || "获取项目分镜失败");
	}

	return parsed.data.data ?? [];
}

/**
 * Stores the prefetched shot metadata for an AI-Saturn project.
 *
 * The editor's own project record holds the timeline; this holds the upstream
 * structure it was built from. Keeping them apart matters because the timeline
 * is the user's work and must never be overwritten by a refetch, while this is
 * a read-only mirror of what AI-Saturn currently has — safe to replace wholesale
 * when the user comes back to pick up newly rendered shots.
 *
 * localStorage rather than sessionStorage: the whole point of prefetching is
 * that the metadata outlives the tab, so a returning user gets the shot list
 * without another round trip. It is a few hundred KB per project, which is well
 * inside the ~5MB budget for the realistic number of projects one user opens.
 */

const KEY_PREFIX = "saturn-project-shots:";

export interface SaturnShotPrefetch {
	projectId: number;
	projectName: string;
	/** ISO timestamp of when this snapshot was taken. */
	fetchedAt: string;
	/** Top-level shots; sub-shots remain nested under their parent. */
	shots: SaturnProjectShot[];
	/** Total shots including sub-shots, for display without re-walking. */
	totalCount: number;
}

/**
 * Validated on read, not cast.
 *
 * This survives across sessions and app versions, so a payload written by an
 * older build is a real possibility — and a malformed one should degrade to
 * "no prefetch" rather than throw inside a render.
 */
const shotPrefetchSchema = z.object({
	projectId: z.number(),
	projectName: z.string(),
	fetchedAt: z.string(),
	shots: z.array(saturnProjectShotSchema),
	totalCount: z.number(),
});

function keyFor(projectId: number): string {
	return `${KEY_PREFIX}${projectId}`;
}

export function saveShotPrefetch(prefetch: SaturnShotPrefetch): void {
	try {
		localStorage.setItem(keyFor(prefetch.projectId), JSON.stringify(prefetch));
	} catch {
		// Quota or private mode. The timeline still works — only the offline
		// structure shortcut is lost, so this is not worth interrupting the flow.
	}
}

export function loadShotPrefetch({
	projectId,
}: {
	projectId: number;
}): SaturnShotPrefetch | null {
	try {
		const raw = localStorage.getItem(keyFor(projectId));
		if (!raw) return null;

		const parsed = shotPrefetchSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function clearShotPrefetch({ projectId }: { projectId: number }): void {
	try {
		localStorage.removeItem(keyFor(projectId));
	} catch {
		// Nothing to do — the entry is unreachable either way.
	}
}

/** Every prefetched project, newest first. */
export function listShotPrefetches(): SaturnShotPrefetch[] {
	try {
		const prefetches: SaturnShotPrefetch[] = [];
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key?.startsWith(KEY_PREFIX)) continue;
			const parsed = shotPrefetchSchema.safeParse(
				JSON.parse(localStorage.getItem(key) ?? "null"),
			);
			// A single corrupt entry should not hide the rest.
			if (parsed.success) prefetches.push(parsed.data);
		}
		return prefetches.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Which shots already have their video in the media library
// ---------------------------------------------------------------------------

/**
 * Records the shots whose rendered video has already been imported.
 *
 * Kept here rather than on the media asset: a MediaAsset carries no upstream
 * identity, so without this list there is nothing to compare a shot against and
 * every re-entry would download the whole project again. Shots are also the unit
 * the rest of this integration addresses.
 *
 * Scoped per editor project rather than per Saturn project, because the assets
 * live in that project's own OPFS directory — deleting the draft takes its media
 * with it, and the list has to be scoped the same way or a rebuilt project would
 * think it still had files it does not.
 */
const IMPORTED_SHOTS_KEY_PREFIX = "saturn-imported-shots:";

export function saveImportedShotIds({
	projectId,
	shotIds,
}: {
	projectId: string;
	shotIds: Set<number>;
}): void {
	try {
		localStorage.setItem(
			`${IMPORTED_SHOTS_KEY_PREFIX}${projectId}`,
			JSON.stringify([...shotIds]),
		);
	} catch {
		// A lost list costs a redundant download on the next visit and nothing
		// else, since importing an asset twice is harmless.
	}
}

export function loadImportedShotIds({
	projectId,
}: {
	projectId: string;
}): Set<number> {
	try {
		const raw = localStorage.getItem(`${IMPORTED_SHOTS_KEY_PREFIX}${projectId}`);
		if (!raw) return new Set();

		const parsed = z.array(z.number()).safeParse(JSON.parse(raw));
		return parsed.success ? new Set(parsed.data) : new Set();
	} catch {
		return new Set();
	}
}

// ---------------------------------------------------------------------------
// Pending open
// ---------------------------------------------------------------------------

/**
 * Records that the next arrival at the editor is an AI-Saturn project that has
 * no local draft yet, and must be created with the platform's own name.
 *
 * The creation itself cannot happen on the landing page: a project is only
 * usable once the editor has mounted its renderer and scenes, so creating one
 * there would produce a record the editor then has to adopt. Instead the intent
 * is parked here and the editor's existing "project not found" path picks it
 * up, which keeps project creation in the one place that already knows how to
 * do it.
 */
const PENDING_OPEN_KEY = "saturn-pending-open";

export interface SaturnPendingOpen {
	saturnProjectId: number;
	projectName: string;
}

export function markPendingOpen(pending: SaturnPendingOpen): void {
	try {
		localStorage.setItem(PENDING_OPEN_KEY, JSON.stringify(pending));
	} catch {
		// Losing this means the editor falls back to an untitled project, which
		// is recoverable by retrying from the platform — not worth failing on.
	}
}

/**
 * Reads the pending open without clearing it.
 *
 * Not consumed on read on purpose. The editor reads this *before* it creates
 * anything, and creation can fail (quota, a panic in the WASM core). If the
 * read also cleared it, that failure would leave the retry with no project name
 * and no upstream id — it would create an untitled orphan and the user would
 * have no way back to the right project. Clearing therefore waits for the
 * creation to actually succeed; see clearPendingOpen.
 */
export function readPendingOpen(): SaturnPendingOpen | null {
	try {
		const raw = localStorage.getItem(PENDING_OPEN_KEY);
		if (!raw) return null;

		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("saturnProjectId" in parsed) ||
			typeof parsed.saturnProjectId !== "number"
		) {
			return null;
		}
		return {
			saturnProjectId: parsed.saturnProjectId,
			projectName:
				"projectName" in parsed && typeof parsed.projectName === "string"
					? parsed.projectName
					: `AI-Saturn 项目 ${parsed.saturnProjectId}`,
		};
	} catch {
		return null;
	}
}

/** Drops the pending open, once it has been acted on successfully. */
export function clearPendingOpen(): void {
	try {
		localStorage.removeItem(PENDING_OPEN_KEY);
	} catch {
		// Nothing to do — the entry is unreachable either way.
	}
}

// ---------------------------------------------------------------------------
// In-memory handoff
// ---------------------------------------------------------------------------

/**
 * Carries the freshly fetched shots from the landing page into the editor,
 * across the client-side navigation between them.
 *
 * The prefetch is persisted as well, but re-reading it in the editor would mean
 * a round trip through JSON on a page already loading a project, and the editor
 * needs the shots only once, on first open. A module-level value disappears on
 * a full page load, which is fine — it is only ever populated by the navigation
 * that immediately precedes its use.
 */
let handoff: { saturnProjectId: number; shots: SaturnProjectShot[] } | null =
	null;

export function setShotHandoff({
	saturnProjectId,
	shots,
}: {
	saturnProjectId: number;
	shots: SaturnProjectShot[];
}): void {
	handoff = { saturnProjectId, shots };
}

export function takeShotHandoff({
	saturnProjectId,
}: {
	saturnProjectId: number;
}): SaturnProjectShot[] | null {
	if (!handoff || handoff.saturnProjectId !== saturnProjectId) return null;
	const shots = handoff.shots;
	handoff = null;
	return shots;
}
