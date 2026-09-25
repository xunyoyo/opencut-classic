import { describe, expect, test } from "bun:test";
import { createWavBlob } from "../wav";

async function readWavHeader(blob: Blob) {
	const view = new DataView(await blob.arrayBuffer());
	const readAscii = ({ offset, length }: { offset: number; length: number }) =>
		String.fromCharCode(...new Uint8Array(view.buffer, offset, length));

	return {
		riff: readAscii({ offset: 0, length: 4 }),
		wave: readAscii({ offset: 8, length: 4 }),
		fmt: readAscii({ offset: 12, length: 4 }),
		audioFormat: view.getUint16(20, true),
		numChannels: view.getUint16(22, true),
		sampleRate: view.getUint32(24, true),
		byteRate: view.getUint32(28, true),
		blockAlign: view.getUint16(32, true),
		bitsPerSample: view.getUint16(34, true),
		data: readAscii({ offset: 36, length: 4 }),
		dataSize: view.getUint32(40, true),
		totalSize: view.buffer.byteLength,
		view,
	};
}

describe("createWavBlob", () => {
	// The transcription path calls this with no options and depends on the old
	// 44.1kHz/stereo header. Parameterising must not move that default.
	test("keeps the 44.1kHz stereo default for existing callers", async () => {
		const samples = new Float32Array(44100 * 2);
		const header = await readWavHeader(createWavBlob({ samples }));

		expect(header.sampleRate).toBe(44100);
		expect(header.numChannels).toBe(2);
		expect(header.byteRate).toBe(44100 * 2 * 2);
		expect(header.blockAlign).toBe(4);
	});

	test("writes the requested sample rate and mono channel count", async () => {
		const samples = new Float32Array(48000);
		const header = await readWavHeader(
			createWavBlob({ samples, sampleRate: 48000, numChannels: 1 }),
		);

		expect(header.riff).toBe("RIFF");
		expect(header.wave).toBe("WAVE");
		expect(header.fmt).toBe("fmt ");
		expect(header.data).toBe("data");
		expect(header.audioFormat).toBe(1);
		expect(header.sampleRate).toBe(48000);
		expect(header.numChannels).toBe(1);
		expect(header.bitsPerSample).toBe(16);
		expect(header.blockAlign).toBe(2);
		expect(header.byteRate).toBe(48000 * 2);
	});

	test("sizes the data chunk from the sample count and channel count", async () => {
		const frames = 1000;
		const numChannels = 2;
		const header = await readWavHeader(
			createWavBlob({
				samples: new Float32Array(frames * numChannels),
				sampleRate: 44100,
				numChannels,
			}),
		);

		expect(header.dataSize).toBe(frames * numChannels * 2);
		expect(header.totalSize).toBe(44 + header.dataSize);
	});

	// A second channel that is not silent must survive, otherwise a mono
	// downmix that dropped a channel would look correct in the header alone.
	test("interleaves channels in frame order", async () => {
		const samples = new Float32Array([1, -1, 0.5, -0.5]);
		const { view } = await readWavHeader(
			createWavBlob({ samples, sampleRate: 44100, numChannels: 2 }),
		);

		expect(view.getInt16(44, true)).toBe(0x7fff);
		expect(view.getInt16(46, true)).toBe(-0x8000);
		expect(view.getInt16(48, true)).toBeGreaterThan(0);
		expect(view.getInt16(50, true)).toBeLessThan(0);
	});

	test("clamps out-of-range samples instead of wrapping them", async () => {
		const samples = new Float32Array([2, -2]);
		const { view } = await readWavHeader(
			createWavBlob({ samples, sampleRate: 44100, numChannels: 1 }),
		);

		expect(view.getInt16(44, true)).toBe(0x7fff);
		expect(view.getInt16(46, true)).toBe(-0x8000);
	});
});
