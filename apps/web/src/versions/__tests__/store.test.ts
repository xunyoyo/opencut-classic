import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	adapterStore,
	createMockIndexedDBAdapterClass,
	resetAdapterStore,
} from "./memory-adapter";
import {
	buildScene,
	buildSceneTracks,
	buildSnapshot,
	buildVersion,
} from "./fixtures";

// The store builds `IndexedDBAdapter`s internally, so the class is replaced
// rather than a database being provided — `bun test` has no `indexedDB`, and
// the behaviour under test (zod parsing, key filtering, prune order) lives
// above the adapter anyway.
mock.module("@/services/storage/indexeddb-adapter", () => ({
	IndexedDBAdapter: createMockIndexedDBAdapterClass(),
	deleteDatabase: async () => {},
}));

const {
	saveVersion,
	listVersions,
	deleteVersion,
	pruneVersions,
	loadVersion,
	MAX_AUTO_VERSIONS_PER_PROJECT,
} = await import("@/versions/store");

const PROJECT_ID = "project-1";

/**
 * Removes line and block comments so a source-level assertion tests the code
 * rather than the prose around it.
 */
function stripComments({ source }: { source: string }): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Silences the store's expected `console.warn`s for the duration of a test.
 *
 * The degradation path deliberately warns once per dropped record, so without
 * this the suite prints a wall of zod issue dumps that look like failures.
 */
async function withQuietWarnings<T>(run: () => Promise<T>): Promise<T> {
	const original = console.warn;
	console.warn = () => {};
	try {
		return await run();
	} finally {
		console.warn = original;
	}
}

/** Reaches into the mocked store to write a raw, unvalidated record. */
async function injectRawRecord({
	projectId = PROJECT_ID,
	versionId,
	value,
}: {
	projectId?: string;
	versionId: string;
	value: unknown;
}): Promise<void> {
	// Create the database by going through the store once, so this helper does
	// not depend on the test having saved something first.
	await pruneVersions({ projectId });

	const db = adapterStore.get("video-editor-project-versions");
	if (!db) throw new Error("mock database was never created");
	db.set(`${projectId}::${versionId}`, {
		id: versionId,
		projectId,
		version: value,
	});
}

beforeEach(() => {
	resetAdapterStore();
});

describe("version record serialization and validation", () => {
	test("round-trips a saved version through the store", async () => {
		await saveVersion({
			version: buildVersion({
				id: "v1",
				name: "第一版",
				isCurrent: true,
				mediaIds: ["media-1", "media-2"],
				// Built through the shared fixtures rather than an inline literal:
				// the element's time fields are branded `MediaTime`, and the
				// fixtures already carry the one documented conversion for that.
				snapshot: buildSnapshot({
					scenes: [
						buildScene({
							tracks: buildSceneTracks({ mainMediaIds: ["media-1"] }),
						}),
					],
				}),
			}),
		});

		const loaded = await loadVersion({
			projectId: PROJECT_ID,
			versionId: "v1",
		});

		expect(loaded).not.toBeNull();
		expect(loaded?.name).toBe("第一版");
		expect(loaded?.isCurrent).toBe(true);
		expect(loaded?.appVersion).toBe(31);
		expect(loaded?.snapshot.scenes).toHaveLength(1);
		expect(loaded?.snapshot.metadata.id).toBe(PROJECT_ID);
		expect(loaded?.snapshot.scenes[0].tracks.main.elements).toHaveLength(1);
	});

	test("degrades a malformed record to 'not listed' instead of throwing", async () => {
		await saveVersion({ version: buildVersion({ id: "good", name: "好的" }) });

		// The shape a truncated write actually produces: `scenes` present but not
		// an array, so the snapshot schema rejects it.
		await injectRawRecord({
			versionId: "bad",
			value: {
				id: "bad",
				projectId: PROJECT_ID,
				name: "坏掉的",
				createdAt: 1,
				isCurrent: false,
				mediaIds: [],
				appVersion: 31,
				isAuto: false,
				snapshot: { scenes: "truncated" },
			},
		});

		const result = await withQuietWarnings(() =>
			listVersions({ projectId: PROJECT_ID }),
		);

		// The read succeeds and the good version survives: one corrupt record
		// must not hide every other version from the user.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.map((v) => v.id)).toEqual(["good"]);
	});

	test("drops a record missing required fields rather than coercing it", async () => {
		await injectRawRecord({
			versionId: "partial",
			value: { id: "partial", projectId: PROJECT_ID, name: "缺字段" },
		});

		const result = await withQuietWarnings(() =>
			listVersions({ projectId: PROJECT_ID }),
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions).toHaveLength(0);
	});

	test("a successful empty read is distinct from a failed one", async () => {
		const result = await listVersions({ projectId: "never-saved-anything" });

		// ok:true with no versions is "you have none"; ok:false is "we could not
		// read them". The panel renders opposite messages for the two.
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions).toEqual([]);
	});

	test("only lists versions belonging to the requested project", async () => {
		await saveVersion({ version: buildVersion({ id: "mine" }) });
		await saveVersion({
			version: buildVersion({ id: "theirs", projectId: "project-2" }),
		});

		const result = await listVersions({ projectId: PROJECT_ID });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.map((v) => v.id)).toEqual(["mine"]);
	});

	test("sorts newest first", async () => {
		await saveVersion({
			version: buildVersion({ id: "old", createdAt: 1_000 }),
		});
		await saveVersion({
			version: buildVersion({ id: "new", createdAt: 2_000 }),
		});

		const result = await listVersions({ projectId: PROJECT_ID });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.map((v) => v.id)).toEqual(["new", "old"]);
	});

	test("summary omits the snapshot so the list stays light", async () => {
		await saveVersion({
			version: buildVersion({ id: "v1", mediaIds: ["media-1"] }),
		});

		const result = await listVersions({ projectId: PROJECT_ID });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const summary = result.versions[0];
		expect("snapshot" in summary).toBe(false);
		expect(summary.mediaCount).toBe(1);
	});
});

describe("version retention", () => {
	test("prunes the oldest auto-versions beyond the limit", async () => {
		const total = MAX_AUTO_VERSIONS_PER_PROJECT + 7;
		for (let index = 0; index < total; index++) {
			await saveVersion({
				version: buildVersion({
					id: `auto-${index}`,
					createdAt: 1_000 + index,
					isAuto: true,
				}),
			});
		}

		const result = await listVersions({ projectId: PROJECT_ID });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.versions).toHaveLength(MAX_AUTO_VERSIONS_PER_PROJECT);
		// Oldest seven are gone, newest survive.
		expect(result.versions.some((v) => v.id === "auto-0")).toBe(false);
		expect(result.versions.some((v) => v.id === `auto-${total - 1}`)).toBe(
			true,
		);
	});

	test("never prunes a hand-named version", async () => {
		// Named versions are outnumbered by auto-snapshots well past the limit;
		// the named one was an explicit request to keep it.
		await saveVersion({
			version: buildVersion({ id: "named", name: "客户定稿", createdAt: 1 }),
		});
		for (let index = 0; index < MAX_AUTO_VERSIONS_PER_PROJECT + 5; index++) {
			await saveVersion({
				version: buildVersion({
					id: `auto-${index}`,
					createdAt: 1_000 + index,
					isAuto: true,
				}),
			});
		}

		const result = await listVersions({ projectId: PROJECT_ID });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.some((v) => v.id === "named")).toBe(true);
	});

	test("never prunes the record marked current, even when it is an auto-snapshot", async () => {
		// The current version is the one matching what is on screen; dropping it
		// would leave the list with no row marked current.
		await saveVersion({
			version: buildVersion({
				id: "current-auto",
				createdAt: 1,
				isAuto: true,
				isCurrent: true,
			}),
		});
		for (let index = 0; index < MAX_AUTO_VERSIONS_PER_PROJECT + 5; index++) {
			await saveVersion({
				version: buildVersion({
					id: `auto-${index}`,
					createdAt: 1_000 + index,
					isAuto: true,
				}),
			});
		}

		const result = await listVersions({ projectId: PROJECT_ID });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.some((v) => v.id === "current-auto")).toBe(true);
	});

	test("pruneVersions reports zero when there is nothing to drop", async () => {
		for (let index = 0; index < MAX_AUTO_VERSIONS_PER_PROJECT + 3; index++) {
			await saveVersion({
				version: buildVersion({
					id: `auto-${index}`,
					createdAt: 1_000 + index,
					isAuto: true,
				}),
			});
		}

		expect(await pruneVersions({ projectId: PROJECT_ID })).toBe(0);
	});

	test("pruning one project leaves another project's versions alone", async () => {
		for (let index = 0; index < 4; index++) {
			await saveVersion({
				version: buildVersion({
					id: `other-${index}`,
					projectId: "project-2",
					createdAt: 1_000 + index,
					isAuto: true,
				}),
			});
		}

		await pruneVersions({ projectId: PROJECT_ID });

		const other = adapterStore.get("video-editor-project-versions");
		expect(other?.size).toBe(4);
	});
});

describe("deleting a version never touches media", () => {
	test("removes only the version record, leaving every other version intact", async () => {
		// Two versions reference the SAME media id. Deleting one must not affect
		// the other's access to those bytes.
		await saveVersion({
			version: buildVersion({
				id: "v1",
				mediaIds: ["shared-media", "only-in-v1"],
			}),
		});
		await saveVersion({
			version: buildVersion({ id: "v2", mediaIds: ["shared-media"] }),
		});

		await deleteVersion({ projectId: PROJECT_ID, versionId: "v1" });

		const result = await listVersions({ projectId: PROJECT_ID });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.versions.map((v) => v.id)).toEqual(["v2"]);

		// The surviving version still carries its media reference — nothing
		// pruned the shared id on the way out.
		const survivor = await loadVersion({
			projectId: PROJECT_ID,
			versionId: "v2",
		});
		expect(survivor?.mediaIds).toEqual(["shared-media"]);
	});

	test("does not call into project/media storage at all", async () => {
		// Guards the invariant structurally: the version store must never
		// acquire a media-deletion dependency. If a future edit imports
		// `deleteMediaAsset`/`deleteProjectMedia` here, this fails.
		//
		// Comments are stripped before matching: the store's own explanation of
		// why it must not delete media names those functions, and a raw text
		// search would flag the documentation rather than any real call.
		const raw = await readFile(new URL("../store.ts", import.meta.url), "utf8");
		const code = stripComments({ source: raw });

		expect(code).not.toContain("deleteMediaAsset");
		expect(code).not.toContain("deleteProjectMedia");
		expect(code).not.toContain("clearAllData");
	});

	test("deleting a version leaves another project's version untouched", async () => {
		await saveVersion({ version: buildVersion({ id: "v1" }) });
		await saveVersion({
			version: buildVersion({ id: "v1", projectId: "project-2" }),
		});

		await deleteVersion({ projectId: PROJECT_ID, versionId: "v1" });

		const other = await loadVersion({
			projectId: "project-2",
			versionId: "v1",
		});
		expect(other).not.toBeNull();
	});
});
