import { describe, expect, test } from "bun:test";
import {
	ORPHANED_MEDIA_FILE_MIN_AGE_MS,
	selectOrphanedMediaFileKeys,
} from "@/services/storage/media-orphans";

const NOW = 1_700_000_000_000;
const OLD = NOW - ORPHANED_MEDIA_FILE_MIN_AGE_MS - 1;

describe("selectOrphanedMediaFileKeys", () => {
	test("keeps every file that still has a metadata record", () => {
		expect(
			selectOrphanedMediaFileKeys({
				files: [
					{ key: "a", lastModified: OLD },
					{ key: "b", lastModified: OLD },
				],
				metadataIds: ["a", "b"],
				now: NOW,
			}),
		).toEqual([]);
	});

	test("picks old files that no metadata record points at", () => {
		expect(
			selectOrphanedMediaFileKeys({
				files: [
					{ key: "kept", lastModified: OLD },
					{ key: "removed", lastModified: OLD },
				],
				metadataIds: ["kept"],
				now: NOW,
			}),
		).toEqual(["removed"]);
	});

	// saveMediaAsset writes the bytes before the record, so a save that is
	// still running looks exactly like an orphan apart from its age.
	test("leaves recently written files alone even without a record", () => {
		expect(
			selectOrphanedMediaFileKeys({
				files: [{ key: "saving", lastModified: NOW - 1000 }],
				metadataIds: [],
				now: NOW,
			}),
		).toEqual([]);
	});

	test("treats a file exactly at the age threshold as orphaned", () => {
		expect(
			selectOrphanedMediaFileKeys({
				files: [{ key: "edge", lastModified: NOW - 500 }],
				metadataIds: new Set<string>(),
				now: NOW,
				minAgeMs: 500,
			}),
		).toEqual(["edge"]);
	});
});
