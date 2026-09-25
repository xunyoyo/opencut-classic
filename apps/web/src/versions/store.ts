import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { withDeadline } from "@/saturn/fetch-timeout";
import {
	projectVersionSchema,
	toSummary,
	type ProjectVersion,
	type ProjectVersionSummary,
} from "./types";
import type { SerializedProject } from "@/services/storage/types";

/**
 * Versions live in their own database, not in `video-editor-projects`.
 *
 * That is the whole reason this feature adds no migration. `runStorageMigrations`
 * walks every record in the projects store and rewrites it through the v0→v31
 * chain; putting version records anywhere near that store would either make
 * them look like projects to the migrator or force a new schema version for
 * data that the project itself does not own. A sibling database keeps both
 * concerns untouched.
 */
const VERSION_DB_NAME = "video-editor-project-versions";
const VERSION_STORE_NAME = "project-versions";

/**
 * How many auto-snapshots one project keeps.
 *
 * Sized against what is actually unbounded: every restore and every exit
 * confirmation writes one, so a user who restores twenty times has twenty
 * snapshots without ever asking for one. Named versions do not count against
 * this — see `pruneVersions`.
 *
 * The unit is count, not bytes, because a snapshot is JSON of scenes/tracks
 * (kilobytes) while media deliberately stays out of it. `warnOnSnapshotSize`
 * measures the real size in the field so this assumption can be checked
 * against production data instead of trusted.
 */
export const MAX_AUTO_VERSIONS_PER_PROJECT = 50;

/** Warn once per project per session rather than on every save. */
const warnedProjects = new Set<string>();

interface StoredVersionRecord {
	id: string;
	projectId: string;
	version: ProjectVersion;
}

/**
 * One record per version, keyed by `projectId::versionId`.
 *
 * The key embeds the project so a project's versions sort contiguously in the
 * store's key order, and so a version id alone can never collide across
 * projects. The record repeats `projectId` because the value has to be
 * filterable on its own — the adapter exposes no index queries.
 */
function keyFor({
	projectId,
	versionId,
}: {
	projectId: string;
	versionId: string;
}): string {
	return `${projectId}::${versionId}`;
}

function createAdapter(): IndexedDBAdapter<StoredVersionRecord> {
	return new IndexedDBAdapter<StoredVersionRecord>({
		dbName: VERSION_DB_NAME,
		storeName: VERSION_STORE_NAME,
		version: 1,
	});
}

/**
 * Reads are deadlined.
 *
 * `IndexedDBAdapter.getDB()` bounds *opening* the database, but the store
 * requests that follow carry only an `onerror` handler — and a request the
 * browser never answers fires neither `success` nor `error`, so the await never
 * settles. This panel is rendered by a click, with no other exit on the path,
 * so a hang here would leave a permanently empty list that looks like "you have
 * no versions". `withDeadline` turns that into the failure state the UI can
 * report and offer a refresh for.
 */
async function readWithDeadline<T>({
	work,
	message,
}: {
	work: Promise<T>;
	message: string;
}): Promise<T> {
	return await withDeadline({ work, message });
}

/**
 * `ok: false` is a read that failed; `versions: []` is a project with none.
 *
 * Kept apart because the two look identical on screen otherwise, and telling a
 * user their work is gone when the read merely failed is the worse lie.
 */
export type ListVersionsResult =
	| { ok: true; versions: ProjectVersionSummary[] }
	| { ok: false; reason: string };

export async function listVersions({
	projectId,
}: {
	projectId: string;
}): Promise<ListVersionsResult> {
	const adapter = createAdapter();

	let keys: string[];
	try {
		keys = await readWithDeadline({
			work: adapter.list(),
			message: "读取版本列表超时。请关闭其他剪辑器标签页后重试。",
		});
	} catch (error) {
		return { ok: false, reason: describeError({ error }) };
	}

	const prefix = `${projectId}::`;
	const ownKeys = keys.filter((key) => key.startsWith(prefix));
	const summaries: ProjectVersionSummary[] = [];
	let droppedMalformed = 0;

	for (const key of ownKeys) {
		const parsed = await readVersion({ adapter, key });
		if (!parsed) {
			droppedMalformed++;
			continue;
		}
		summaries.push(toSummary({ version: parsed }));
	}

	if (droppedMalformed > 0) {
		// Degrading to "skip this one" rather than failing the whole list: a
		// single truncated write must not hide every other version from the
		// user. Same stance as the malformed-project handling in
		// `services/storage/service.ts`.
		console.warn(
			`[versions] skipped ${droppedMalformed} malformed record(s) for project ${projectId}`,
		);
	}

	return {
		ok: true,
		versions: summaries.sort((a, b) => b.createdAt - a.createdAt),
	};
}

async function readVersion({
	adapter,
	key,
}: {
	adapter: IndexedDBAdapter<StoredVersionRecord>;
	key: string;
}): Promise<ProjectVersion | null> {
	let record: StoredVersionRecord | null;
	try {
		record = await readWithDeadline({
			work: adapter.get(key),
			message: "读取版本记录超时。",
		});
	} catch {
		// A single unreadable record is indistinguishable from a missing one
		// here; both mean "not shown". The project-wide read above is what
		// decides between the failure and empty states.
		return null;
	}

	if (!record || typeof record !== "object" || !("version" in record)) {
		return null;
	}

	// Parsed, not cast. These records outlive the build that wrote them, so a
	// shape from an older or newer app version is expected input rather than a
	// programming error — a bad one degrades to "this version is not listed".
	const parsed = projectVersionSchema.safeParse(record.version);
	if (!parsed.success) {
		console.warn("[versions] dropping unparseable version record:", {
			key,
			issues: parsed.error.issues,
		});
		return null;
	}

	// The one place the schema's output is re-widened to `ProjectVersion`. The
	// schema is deliberately looser on a snapshot's *contents* (see
	// `snapshotSchema`): it pins what a read must check to be safe, while the
	// type describes the fuller object the write side produced. The validated
	// record is therefore narrower on paper than the type claims. That is
	// sound because the only consumer of the extra fields — the restore path in
	// `manager.ts` — rebuilds each scene field by field and ignores what it
	// does not recognise, exactly as `loadProject` does for a stored project.
	//
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowing than the schema validates, justified above
	return parsed.data as ProjectVersion;
}

export async function saveVersion({
	version,
}: {
	version: ProjectVersion;
}): Promise<void> {
	const adapter = createAdapter();
	await adapter.set({
		key: keyFor({ projectId: version.projectId, versionId: version.id }),
		value: { id: version.id, projectId: version.projectId, version },
	});

	warnOnSnapshotSize({ version });
	await pruneVersions({ projectId: version.projectId });
}

/**
 * Reports the first snapshot that crosses a size threshold, once per project.
 *
 * The retention limit is a count, which is only safe while a snapshot stays
 * small. That is an assumption about scene JSON, and the only way to check it
 * is against real projects — so the size is measured where snapshots are
 * actually written and surfaced in logs once, not on every save.
 */
function warnOnSnapshotSize({ version }: { version: ProjectVersion }): void {
	if (warnedProjects.has(version.projectId)) return;

	let bytes: number;
	try {
		bytes = new Blob([JSON.stringify(version)]).size;
	} catch {
		return;
	}

	if (bytes < 1_000_000) return;

	warnedProjects.add(version.projectId);
	console.warn(
		`[versions] snapshot for project ${version.projectId} is ${bytes} bytes; retention of ${MAX_AUTO_VERSIONS_PER_PROJECT} auto-versions assumes snapshots stay small`,
	);
}

/** Marks one version as the current one and clears the flag on the rest. */
export async function markVersionCurrent({
	projectId,
	versionId,
}: {
	projectId: string;
	versionId: string;
}): Promise<void> {
	const adapter = createAdapter();
	const entries = await readAllForProject({ adapter, projectId });

	for (const { key, version } of entries) {
		const shouldBeCurrent = version.id === versionId;
		if (version.isCurrent === shouldBeCurrent) continue;
		await adapter.set({
			key,
			value: {
				id: version.id,
				projectId,
				version: { ...version, isCurrent: shouldBeCurrent },
			},
		});
	}
}

export async function deleteVersion({
	projectId,
	versionId,
}: {
	projectId: string;
	versionId: string;
}): Promise<void> {
	const adapter = createAdapter();
	// Only the version record is removed. Media bytes are shared with the
	// project and with every other version that references the same media ids,
	// so nothing here may touch `deleteMediaAsset`/`deleteProjectMedia`: this
	// store has no way to know whether another version still needs those bytes.
	await adapter.remove(keyFor({ projectId, versionId }));
}

/**
 * Drops the oldest auto-snapshots once a project exceeds the limit.
 *
 * Only `isAuto` records are candidates. A version the user saved by hand —
 * named or not — was an explicit request to keep it, so silently deleting one
 * to make room for a snapshot the editor took on its own would be the worst
 * possible trade. Auto-snapshots are the entire source of unbounded growth, so
 * capping them alone bounds the store.
 *
 * The current-version record is never dropped even when it is an auto-snapshot:
 * it is the one pointing at the state on screen, and removing it would leave
 * the list with no row marked current.
 */
export async function pruneVersions({
	projectId,
}: {
	projectId: string;
}): Promise<number> {
	const adapter = createAdapter();
	const entries = await readAllForProject({ adapter, projectId });

	const autoVersions = entries
		.filter(({ version }) => version.isAuto && !version.isCurrent)
		.sort((a, b) => a.version.createdAt - b.version.createdAt);

	const excess = autoVersions.length - MAX_AUTO_VERSIONS_PER_PROJECT;
	if (excess <= 0) return 0;

	const toDrop = autoVersions.slice(0, excess);
	for (const { key } of toDrop) {
		await adapter.remove(key);
	}

	return toDrop.length;
}

/**
 * Loads one version with its snapshot, for restoring.
 *
 * Separate from `listVersions` because the list has no need for scene data and
 * the restore path needs nothing else.
 */
export async function loadVersion({
	projectId,
	versionId,
}: {
	projectId: string;
	versionId: string;
}): Promise<ProjectVersion | null> {
	const adapter = createAdapter();
	return await readVersion({
		adapter,
		key: keyFor({ projectId, versionId }),
	});
}

export async function loadAllVersions({
	projectId,
}: {
	projectId: string;
}): Promise<ProjectVersion[]> {
	const adapter = createAdapter();
	const entries = await readAllForProject({ adapter, projectId });
	return entries.map((entry) => entry.version);
}

async function readAllForProject({
	adapter,
	projectId,
}: {
	adapter: IndexedDBAdapter<StoredVersionRecord>;
	projectId: string;
}): Promise<Array<{ key: string; version: ProjectVersion }>> {
	const keys = await readWithDeadline({
		work: adapter.list(),
		message: "读取版本列表超时。",
	});

	const prefix = `${projectId}::`;
	const entries: Array<{ key: string; version: ProjectVersion }> = [];

	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		const version = await readVersion({ adapter, key });
		if (version) entries.push({ key, version });
	}

	return entries;
}

/** Removes every version belonging to a project. Called when the project goes. */
export async function deleteVersionsForProject({
	projectId,
}: {
	projectId: string;
}): Promise<void> {
	const adapter = createAdapter();
	await readWithDeadline({
		work: (async () => {
			const entries = await readAllForProject({ adapter, projectId });
			for (const { key } of entries) {
				await adapter.remove(key);
			}
		})(),
		message: "删除版本记录超时。",
	});
}

/** Serializes a snapshot for size measurement in tests and diagnostics. */
export function measureSnapshotBytes({
	snapshot,
}: {
	snapshot: SerializedProject;
}): number {
	return new Blob([JSON.stringify(snapshot)]).size;
}

function describeError({ error }: { error: unknown }): string {
	return error instanceof Error ? error.message : "读取版本列表失败";
}
