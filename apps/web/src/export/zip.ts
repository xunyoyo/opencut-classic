/**
 * A minimal ZIP writer for export artifacts, with **stored** (uncompressed)
 * entries only.
 *
 * Stored rather than deflated on purpose: every artifact this packs is already
 * a compressed stream (MP3, AAC, VP9, H.264), so deflate would spend CPU to
 * save approximately nothing. Dropping it removes the compressor, the whole
 * dependency, and the risk that goes with one — what is left is three fixed
 * record layouts and a CRC-32 table, all pure byte manipulation, which is why
 * this module is unit-testable under `bun test` with no browser.
 *
 * Layout implemented (APPNOTE 6.3.x, the subset a stored-entry archive needs):
 *
 *   [local file header][file data] ... [central directory entry] ...
 *   [end of central directory]
 */

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_ENTRY_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;

/** "Store" in the compression-method field, i.e. no compression. */
const COMPRESSION_METHOD_STORED = 0;

/**
 * General purpose bit 11: "the file name and comment are UTF-8". Without this
 * bit a reader falls back to CP437, which is what turns a Chinese filename into
 * mojibake on Windows — the platform most likely to use a third-party unzipper.
 */
const FLAG_UTF8_NAMES = 0x0800;

/** ZIP's epoch: DOS timestamps cannot represent anything before 1980. */
const DOS_EPOCH_YEAR = 1980;

type ZipEntryInput = {
	name: string;
	data: Uint8Array | Blob;
};

export class ZipLimitExceededError extends Error {
	constructor({ message }: { message: string }) {
		super(message);
		this.name = "ZipLimitExceededError";
	}
}

/**
 * The CRC-32 table for the reflected polynomial 0xEDB88320.
 *
 * Built once at module load rather than inlined as 256 literals: it is the same
 * 256 values as the canonical table but the generator is auditable, and the unit
 * tests pin its output against the standard check value.
 */
const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let value = i;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value >>> 0;
	}
	return table;
}

/**
 * CRC-32 (IEEE 802.3), the checksum ZIP requires.
 *
 * Returned unsigned: JavaScript's bitwise operators produce *signed* 32-bit
 * results, so without the final `>>> 0` a checksum with the high bit set would
 * come back negative and be written as a wrong 4-byte field.
 */
export function crc32({ data }: { data: Uint8Array }): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Whether a single entry is representable without ZIP64 extensions.
 *
 * Non-ZIP64 ZIP stores sizes and offsets as 32-bit fields, so the ceiling is
 * `0xFFFFFFFF` bytes (~4 GiB) — and, less obviously, **4095 entries**, since
 * the entry-count field is 16-bit while the file-size fields are not.
 */
export function exceedsZip32Limits({
	fileSize,
	totalSize,
	entryCount,
}: {
	fileSize: number;
	totalSize: number;
	entryCount: number;
}): boolean {
	const ZIP32_MAX = 0xffffffff;
	const ZIP32_MAX_ENTRIES = 0xffff;
	return (
		fileSize > ZIP32_MAX ||
		totalSize > ZIP32_MAX ||
		entryCount > ZIP32_MAX_ENTRIES
	);
}

/**
 * Asserts an entry set can be represented without ZIP64 extensions, throwing if
 * not.
 *
 * Rejecting rather than emitting a best-effort file is deliberate: a plain ZIP
 * writes sizes and offsets as 32-bit fields, so an oversized entry would be
 * silently truncated and unpack to a corrupt artifact — a failure the user only
 * discovers after the download. Exposed separately from `createZip` so the
 * boundary is unit-testable without allocating 4 GiB.
 */
export function assertWithinZip32Limits({
	fileSize,
	totalSize,
	entryCount,
	name,
}: {
	fileSize: number;
	totalSize: number;
	entryCount: number;
	name: string;
}): void {
	if (!exceedsZip32Limits({ fileSize, totalSize, entryCount })) return;

	throw new ZipLimitExceededError({
		message:
			`ZIP entry "${name}" exceeds the 4 GiB limit of a plain ZIP archive` +
			" (ZIP64 is not supported by this exporter)",
	});
}

/**
 * Rejects names that would escape the archive or that a reader cannot round
 * trip, and normalises the separators to `/`.
 *
 * The traversal check matters because these names are derived from project
 * titles, which are user-controlled text.
 */
function normalizeEntryName({ name }: { name: string }): Uint8Array {
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		throw new Error("ZIP entry name must not be empty");
	}

	const normalized = trimmed.replace(/\\/g, "/");
	const segments = normalized.split("/");

	if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		throw new Error(`ZIP entry name must be relative: "${name}"`);
	}
	if (segments.includes("..")) {
		throw new Error(`ZIP entry name must not traverse upwards: "${name}"`);
	}
	if (normalized.endsWith("/")) {
		throw new Error(`ZIP entry name must not be a directory: "${name}"`);
	}

	return encodeUtf8({ text: normalized });
}

/**
 * Always UTF-8, never the platform's default: the container is not allowed to
 * depend on the machine that produced it, and `TextEncoder` is what makes the
 * UTF-8 flag bit honest.
 */
function encodeUtf8({ text }: { text: string }): Uint8Array {
	return new TextEncoder().encode(text);
}

/**
 * Copies a caller's bytes into a buffer this module owns.
 *
 * `Blob` only accepts an `ArrayBuffer`-backed view, while the `Uint8Array` a
 * caller passes in is typed over `ArrayBufferLike` (which includes
 * `SharedArrayBuffer`). Copying is what makes the narrowing a checked fact
 * rather than an assertion, and these payloads are already-compressed media
 * that the CRC pass reads from start to finish anyway.
 */
function toOwnedBytes({ data }: { data: Uint8Array }): Uint8Array<ArrayBuffer> {
	return new Uint8Array(data);
}

/**
 * Packs a JS `Date` into DOS date/time words (fields are 1-1980 based years and
 * seconds are stored in units of two, so the low bit of the second is dropped).
 */
function toDosDateTime({ date }: { date: Date }): {
	time: number;
	date: number;
} {
	const year = Math.max(DOS_EPOCH_YEAR, date.getFullYear());
	return {
		time:
			(Math.floor(date.getSeconds() / 2) & 0x1f) |
			((date.getMinutes() & 0x3f) << 5) |
			((date.getHours() & 0x1f) << 11),
		date:
			(date.getDate() & 0x1f) |
			(((date.getMonth() + 1) & 0x0f) << 5) |
			(((year - DOS_EPOCH_YEAR) & 0x7f) << 9),
	};
}

type PreparedEntry = {
	nameBytes: Uint8Array;
	crc: number;
	size: number;
	// Pinned to the concrete `ArrayBuffer` rather than the default
	// `ArrayBufferLike`: only the former is a legal `BlobPart`, and `Blob`
	// refuses a `SharedArrayBuffer`-backed view.
	data: Uint8Array<ArrayBuffer>;
	offset: number;
	time: number;
	date: number;
};

/**
 * Builds a ZIP archive containing every entry, uncompressed.
 *
 * `data` accepts a `Blob` so a multi-hundred-megabyte export can be handed over
 * without first materialising it as an owned buffer — the bytes only need to
 * be read once, for the CRC, and the Blob is otherwise passed straight through
 * to the output `Blob`'s own part list.
 */
export async function createZip({
	entries,
	date = new Date(),
}: {
	entries: ZipEntryInput[];
	/**
	 * Timestamp stamped on every entry. Defaults to now; pass a fixed value for
	 * reproducible bytes in tests.
	 */
	date?: Date;
}): Promise<Blob> {
	if (entries.length === 0) {
		throw new Error("Cannot build a ZIP archive with no entries");
	}

	const dos = toDosDateTime({ date });
	const prepared: PreparedEntry[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBytes = normalizeEntryName({ name: entry.name });
		// The CRC has to run over the real bytes, so a Blob entry is read once
		// here and the resulting view is what gets stored — the alternative,
		// keeping the Blob and reading it again at write time, costs a second
		// full copy of every byte.
		const data: Uint8Array<ArrayBuffer> =
			entry.data instanceof Blob
				? new Uint8Array(await entry.data.arrayBuffer())
				: toOwnedBytes({ data: entry.data });

		assertWithinZip32Limits({
			fileSize: data.byteLength,
			totalSize: offset,
			entryCount: prepared.length,
			name: entry.name,
		});

		prepared.push({
			nameBytes,
			crc: crc32({ data }),
			size: data.byteLength,
			data,
			offset,
			time: dos.time,
			date: dos.date,
		});

		offset += LOCAL_FILE_HEADER_SIZE + nameBytes.length + data.byteLength;
	}

	const centralDirectorySize = prepared.reduce(
		({ total }, entry) => ({
			total: total + CENTRAL_DIRECTORY_ENTRY_SIZE + entry.nameBytes.length,
		}),
		{ total: 0 },
	).total;

	const parts: BlobPart[] = [];

	for (const entry of prepared) {
		const header = new Uint8Array(
			LOCAL_FILE_HEADER_SIZE + entry.nameBytes.length,
		);
		const view = new DataView(header.buffer);
		view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
		view.setUint16(4, 20, true); // version needed to extract: 2.0
		view.setUint16(6, FLAG_UTF8_NAMES, true);
		view.setUint16(8, COMPRESSION_METHOD_STORED, true);
		view.setUint16(10, entry.time, true);
		view.setUint16(12, entry.date, true);
		view.setUint32(14, entry.crc, true);
		view.setUint32(18, entry.size, true);
		view.setUint32(22, entry.size, true); // uncompressed == compressed
		view.setUint16(26, entry.nameBytes.length, true);
		view.setUint16(28, 0, true); // extra field length
		header.set(entry.nameBytes, LOCAL_FILE_HEADER_SIZE);

		parts.push(header, entry.data);
	}

	const centralDirectory = new Uint8Array(centralDirectorySize);
	const centralView = new DataView(centralDirectory.buffer);
	let cursor = 0;

	for (const entry of prepared) {
		centralView.setUint32(cursor, CENTRAL_DIRECTORY_SIGNATURE, true);
		centralView.setUint16(cursor + 4, 20, true); // version made by
		centralView.setUint16(cursor + 6, 20, true); // version needed
		centralView.setUint16(cursor + 8, FLAG_UTF8_NAMES, true);
		centralView.setUint16(cursor + 10, COMPRESSION_METHOD_STORED, true);
		centralView.setUint16(cursor + 12, entry.time, true);
		centralView.setUint16(cursor + 14, entry.date, true);
		centralView.setUint32(cursor + 16, entry.crc, true);
		centralView.setUint32(cursor + 20, entry.size, true);
		centralView.setUint32(cursor + 24, entry.size, true);
		centralView.setUint16(cursor + 28, entry.nameBytes.length, true);
		centralView.setUint16(cursor + 30, 0, true); // extra field length
		centralView.setUint16(cursor + 32, 0, true); // comment length
		centralView.setUint16(cursor + 34, 0, true); // disk number start
		centralView.setUint16(cursor + 36, 0, true); // internal attributes
		centralView.setUint32(cursor + 38, 0, true); // external attributes
		centralView.setUint32(cursor + 42, entry.offset, true);
		centralDirectory.set(
			entry.nameBytes,
			cursor + CENTRAL_DIRECTORY_ENTRY_SIZE,
		);

		cursor += CENTRAL_DIRECTORY_ENTRY_SIZE + entry.nameBytes.length;
	}

	// The central directory's own offset is where the file data ends, which is
	// exactly the running `offset` left over from the header pass.
	const centralDirectoryOffset = offset;

	parts.push(centralDirectory);

	const end = new Uint8Array(END_OF_CENTRAL_DIRECTORY_SIZE);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
	endView.setUint16(4, 0, true); // this disk number
	endView.setUint16(6, 0, true); // disk with central directory
	endView.setUint16(8, prepared.length, true);
	endView.setUint16(10, prepared.length, true);
	endView.setUint32(12, centralDirectorySize, true);
	endView.setUint32(16, centralDirectoryOffset, true);
	endView.setUint16(20, 0, true); // comment length

	parts.push(end);

	return new Blob(parts, { type: "application/zip" });
}
