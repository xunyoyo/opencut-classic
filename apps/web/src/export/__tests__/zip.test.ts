import { describe, expect, test } from "bun:test";
import {
	assertWithinZip32Limits,
	createZip,
	crc32,
	exceedsZip32Limits,
	ZipLimitExceededError,
} from "../zip";

const encoder = new TextEncoder();

function bytes({ text }: { text: string }): Uint8Array {
	return encoder.encode(text);
}

async function readZip({ blob }: { blob: Blob }) {
	const buffer = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(buffer.buffer);

	const findSignature = ({ signature }: { signature: number }) => {
		for (let i = 0; i <= buffer.length - 4; i++) {
			if (view.getUint32(i, true) === signature) return i;
		}
		return -1;
	};

	const readAscii = ({ offset, length }: { offset: number; length: number }) =>
		String.fromCharCode(...buffer.subarray(offset, offset + length));

	const endOffset = findSignature({ signature: 0x06054b50 });

	return {
		buffer,
		view,
		readAscii,
		endOffset,
		localHeaderOffset: findSignature({ signature: 0x04034b50 }),
		centralOffset: findSignature({ signature: 0x02014b50 }),
		entryCount: view.getUint16(endOffset + 8, true),
		centralDirectorySize: view.getUint32(endOffset + 12, true),
		centralDirectoryOffset: view.getUint32(endOffset + 16, true),
	};
}

describe("crc32", () => {
	// The published check value for the reflected 0xEDB88320 polynomial: if the
	// table generator is wrong, this is the test that catches it.
	test("matches the standard check value for '123456789'", () => {
		expect(crc32({ data: bytes({ text: "123456789" }) })).toBe(0xcbf43926);
	});

	test("is zero for empty input", () => {
		expect(crc32({ data: new Uint8Array(0) })).toBe(0);
	});

	test("returns an unsigned value for input with the high bit set", () => {
		const result = crc32({ data: new Uint8Array([0xff, 0xff, 0xff, 0xff]) });
		expect(result).toBeGreaterThanOrEqual(0);
		expect(result).toBeLessThanOrEqual(0xffffffff);
	});

	test("differs for different inputs of the same length", () => {
		expect(crc32({ data: bytes({ text: "abcd" }) })).not.toBe(
			crc32({ data: bytes({ text: "abce" }) }),
		);
	});
});

describe("exceedsZip32Limits", () => {
	test("accepts a small archive", () => {
		expect(
			exceedsZip32Limits({ fileSize: 1024, totalSize: 1024, entryCount: 3 }),
		).toBe(false);
	});

	test("accepts exactly the 32-bit ceiling", () => {
		expect(
			exceedsZip32Limits({
				fileSize: 0xffffffff,
				totalSize: 0xffffffff,
				entryCount: 1,
			}),
		).toBe(false);
	});

	test("rejects a single entry over 4 GiB", () => {
		expect(
			exceedsZip32Limits({
				fileSize: 0xffffffff + 1,
				totalSize: 0,
				entryCount: 1,
			}),
		).toBe(true);
	});

	test("rejects a total size over 4 GiB even when each entry fits", () => {
		expect(
			exceedsZip32Limits({
				fileSize: 1024,
				totalSize: 0xffffffff + 1,
				entryCount: 2,
			}),
		).toBe(true);
	});

	// The entry-count field is 16-bit while the size fields are 32-bit, so a
	// small archive can still overflow the record count.
	test("rejects more entries than the 16-bit count field allows", () => {
		expect(
			exceedsZip32Limits({ fileSize: 1, totalSize: 1, entryCount: 0xffff + 1 }),
		).toBe(true);
	});
});

describe("createZip", () => {
	test("packs a single entry with a readable structure", async () => {
		const blob = await createZip({
			entries: [{ name: "video.mp4", data: bytes({ text: "hello" }) }],
		});
		const zip = await readZip({ blob });

		expect(zip.localHeaderOffset).toBe(0);
		expect(zip.entryCount).toBe(1);
		expect(zip.readAscii({ offset: 0, length: 4 })).toBe("PK\u0003\u0004");
		expect(zip.readAscii({ offset: zip.endOffset, length: 4 })).toBe(
			"PK\u0005\u0006",
		);
		expect(
			zip.readAscii({ offset: zip.centralDirectoryOffset, length: 4 }),
		).toBe("PK\u0001\u0002");
	});

	test("stores data uncompressed and records the true CRC", async () => {
		const payload = bytes({ text: "hello" });
		const blob = await createZip({
			entries: [{ name: "a.txt", data: payload }],
		});
		const zip = await readZip({ blob });

		expect(zip.view.getUint16(8, true)).toBe(0); // stored, not deflated
		expect(zip.view.getUint32(14, true)).toBe(crc32({ data: payload }));
		expect(zip.view.getUint32(18, true)).toBe(payload.byteLength);
		expect(zip.view.getUint32(22, true)).toBe(payload.byteLength);
		expect(zip.readAscii({ offset: 30 + 5, length: payload.byteLength })).toBe(
			"hello",
		);
	});

	test("packs multiple entries, each at its own recorded offset", async () => {
		const first = bytes({ text: "one" });
		const second = bytes({ text: "two" });
		const blob = await createZip({
			entries: [
				{ name: "first.txt", data: first },
				{ name: "second.txt", data: second },
			],
		});
		const zip = await readZip({ blob });

		expect(zip.entryCount).toBe(2);

		// Second data starts after the first local header, name and payload.
		const secondDataOffset =
			30 + "first.txt".length + first.byteLength + 30 + "second.txt".length;
		expect(
			zip.readAscii({ offset: secondDataOffset, length: second.byteLength }),
		).toBe("two");
	});

	test("accepts Blob entries", async () => {
		const payload = new Uint8Array(bytes({ text: "blobby" }));
		const blob = await createZip({
			entries: [{ name: "blob.bin", data: new Blob([payload]) }],
		});
		const zip = await readZip({ blob });

		expect(zip.view.getUint32(18, true)).toBe("blobby".length);
	});

	test("handles an empty entry", async () => {
		const blob = await createZip({
			entries: [{ name: "empty.txt", data: new Uint8Array(0) }],
		});
		const zip = await readZip({ blob });

		expect(zip.view.getUint32(14, true)).toBe(0); // CRC of nothing is 0
		expect(zip.view.getUint32(18, true)).toBe(0);
		expect(zip.entryCount).toBe(1);
	});

	// Without general purpose bit 11 a reader assumes CP437, which is what turns
	// a Chinese filename into mojibake on Windows.
	test("sets the UTF-8 filename flag for non-ASCII names", async () => {
		const blob = await createZip({
			entries: [{ name: "音频导出.mp3", data: bytes({ text: "x" }) }],
		});
		const zip = await readZip({ blob });

		expect(zip.view.getUint16(6, true) & 0x0800).toBe(0x0800);
		// Same bit in the central directory record, which is what unzippers read.
		expect(zip.view.getUint16(zip.centralOffset + 8, true) & 0x0800).toBe(
			0x0800,
		);

		const nameLength = zip.view.getUint16(26, true);
		const name = new TextDecoder().decode(
			zip.buffer.subarray(30, 30 + nameLength),
		);
		expect(name).toBe("音频导出.mp3");
	});

	test("rejects traversal and absolute names", async () => {
		await expect(
			createZip({
				entries: [{ name: "../escape.mp3", data: bytes({ text: "x" }) }],
			}),
		).rejects.toThrow();
		await expect(
			createZip({
				entries: [{ name: "/etc/passwd", data: bytes({ text: "x" }) }],
			}),
		).rejects.toThrow();
		await expect(
			createZip({ entries: [{ name: "", data: bytes({ text: "x" }) }] }),
		).rejects.toThrow();
	});

	test("rejects an archive with no entries", async () => {
		await expect(createZip({ entries: [] })).rejects.toThrow();
	});

	test("raises ZipLimitExceededError for an oversized entry", () => {
		// A real >4 GiB payload is impractical in a unit test, so the guard is
		// driven through the assertion it delegates to.
		expect(() =>
			assertWithinZip32Limits({
				fileSize: 0xffffffff + 1,
				totalSize: 0,
				entryCount: 1,
				name: "huge.mp4",
			}),
		).toThrow(ZipLimitExceededError);

		expect(() =>
			assertWithinZip32Limits({
				fileSize: 1024,
				totalSize: 1024,
				entryCount: 1,
				name: "small.mp4",
			}),
		).not.toThrow();

		try {
			assertWithinZip32Limits({
				fileSize: 0xffffffff + 1,
				totalSize: 0,
				entryCount: 1,
				name: "huge.mp4",
			});
			throw new Error("expected assertWithinZip32Limits to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ZipLimitExceededError);
			if (error instanceof ZipLimitExceededError) {
				expect(error.name).toBe("ZipLimitExceededError");
			}
		}
	});
});
