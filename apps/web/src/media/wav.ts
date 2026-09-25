/**
 * The 16-bit PCM / WAV writer, split out of `media/mediabunny.ts` so that both
 * the transcription path and the standalone audio export can reach it without
 * either importing the other (a cycle Next warns about at build time).
 */

export const DEFAULT_WAV_SAMPLE_RATE = 44100;
export const DEFAULT_WAV_NUM_CHANNELS = 2;

export type WavBlobOptions = {
	samples: Float32Array;
	/** Defaults to the transcription constants so existing callers are unaffected. */
	sampleRate?: number;
	numChannels?: number;
};

export function interleaveAudioBuffer({
	audioBuffer,
	numChannels = DEFAULT_WAV_NUM_CHANNELS,
}: {
	audioBuffer: AudioBuffer;
	numChannels?: number;
}): Float32Array {
	const sourceChannelCount = Math.min(
		numChannels,
		audioBuffer.numberOfChannels,
	);
	const length = audioBuffer.length;
	const interleavedSamples = new Float32Array(length * numChannels);

	// Resolve each output channel to its source buffer once. getChannelData() is
	// a Web Audio API call rather than a property read, so leaving it inside the
	// sample loop costs a JS/C++ boundary crossing per sample per channel — tens
	// of millions of them for a few minutes of 44.1kHz audio, which blocks the
	// main thread long enough to freeze the tab.
	const sourceChannels: Float32Array[] = [];
	for (let channel = 0; channel < numChannels; channel++) {
		sourceChannels.push(
			audioBuffer.getChannelData(
				Math.min(channel, Math.max(0, sourceChannelCount - 1)),
			),
		);
	}

	for (let sampleIndex = 0; sampleIndex < length; sampleIndex++) {
		for (let channel = 0; channel < numChannels; channel++) {
			interleavedSamples[sampleIndex * numChannels + channel] =
				sourceChannels[channel][sampleIndex] ?? 0;
		}
	}

	return interleavedSamples;
}

export function createWavBlob({
	samples,
	sampleRate = DEFAULT_WAV_SAMPLE_RATE,
	numChannels = DEFAULT_WAV_NUM_CHANNELS,
}: WavBlobOptions): Blob {
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const numSamples = samples.length / numChannels;
	const dataSize = numSamples * numChannels * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	// riff header
	writeString({ view, offset: 0, str: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ view, offset: 8, str: "WAVE" });

	// fmt chunk
	writeString({ view, offset: 12, str: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
	view.setUint16(32, numChannels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);

	// data chunk
	writeString({ view, offset: 36, str: "data" });
	view.setUint32(40, dataSize, true);

	// convert float32 to int16 and write
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		view.setInt16(offset, int16, true);
		offset += 2;
	}

	return new Blob([buffer], { type: "audio/wav" });
}

function writeString({
	view,
	offset,
	str,
}: {
	view: DataView;
	offset: number;
	str: string;
}): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
