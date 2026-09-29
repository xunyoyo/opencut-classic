/**
 * How old an OPFS media file with no metadata record must be before it is
 * treated as abandoned rather than as a save that is still in flight.
 *
 * `saveMediaAsset` writes the bytes first and the metadata record second, so
 * for the length of one save a file legitimately has no record. The file's
 * `lastModified` is stamped when its writable closes, i.e. immediately before
 * the record is written, so anything older than this is not a save in progress.
 */
export const ORPHANED_MEDIA_FILE_MIN_AGE_MS = 10 * 60 * 1000;

export interface StoredMediaFileEntry {
	key: string;
	lastModified: number;
}

/**
 * Picks the stored media files that no metadata record points at any more.
 *
 * Removing an asset drops its metadata record straight away but leaves the
 * bytes in place, so undoing the removal can reattach them without rewriting
 * a file the in-memory asset is still reading from. The bytes that were never
 * reattached are what this finds; the caller deletes them.
 */
export function selectOrphanedMediaFileKeys({
	files,
	metadataIds,
	now,
	minAgeMs = ORPHANED_MEDIA_FILE_MIN_AGE_MS,
}: {
	files: StoredMediaFileEntry[];
	metadataIds: Iterable<string>;
	now: number;
	minAgeMs?: number;
}): string[] {
	const known = new Set(metadataIds);
	return files
		.filter(
			(file) => !known.has(file.key) && now - file.lastModified >= minAgeMs,
		)
		.map((file) => file.key);
}
