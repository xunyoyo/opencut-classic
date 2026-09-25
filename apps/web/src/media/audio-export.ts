import {
	AudioBufferSource,
	BufferTarget,
	canEncodeAudio,
	Mp3OutputFormat,
	Mp4OutputFormat,
	Output,
	type AudioCodec,
	type OutputFormat,
} from "mediabunny";
/**
 * DO NOT upgrade `@mediabunny/mp3-encoder` independently of `mediabunny`.
 *
 * The two packages must stay on the **same version**. The encoder registers
 * itself against the host's `mediabunny` and imports internals that move between
 * releases: at 1.59.1 it imports `Logging`, which `mediabunny@1.41.0` does not
 * export, and the bundle fails to build with "No matching export ... for import
 * Logging" — a failure that surfaces at bundling time, not at runtime, and says
 * nothing about MP3.
 *
 * Hence `apps/web/package.json` pins this to an exact `1.41.0` (no caret) to
 * match `mediabunny`. `package.json` cannot hold the explanation because it is
 * strict JSON, so it lives here. If `mediabunny` is bumped, bump this to the
 * same version in the same commit and re-run the MP3 path.
 */
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import { createTimelineAudioBuffer } from "@/media/audio";
import {
	getSilentDurationTicks,
	resolveAudioExportRange,
} from "@/media/audio-export-range";
import { createWavBlob, interleaveAudioBuffer } from "@/media/wav";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	getAudioExportMimeType,
	getAudioExportFileExtension,
	getAudioChannelCount,
	type AudioChannelLayout,
	type AudioExportFormat,
	type AudioExportResult,
} from "@/export";

/**
 * Raised when the browser cannot encode the requested codec/parameters. Kept
 * distinct from a generic failure because the cause is the environment, not the
 * project, and the UI should be able to say so rather than offering a retry
 * that will fail identically.
 */
export class AudioExportUnsupportedError extends Error {
	constructor({ message }: { message: string }) {
		super(message);
		this.name = "AudioExportUnsupportedError";
	}
}

/**
 * The browser has no native MP3 encoder, so MP3 only exists because LAME was
 * registered as a custom encoder in mediabunny's registry. Registration is
 * idempotent but pulls in the LAME bundle, so it is deferred to the first MP3
 * export: a project exported as MP4 never pays for the download.
 */
let isMp3EncoderRegistered = false;

function ensureMp3EncoderRegistered(): void {
	if (isMp3EncoderRegistered) return;
	isMp3EncoderRegistered = true;
	registerMp3Encoder();
}

function createOutputFormat({
	format,
}: {
	format: AudioExportFormat;
}): OutputFormat {
	switch (format) {
		case "mp3":
			return new Mp3OutputFormat();
		case "m4a":
			return new Mp4OutputFormat();
		case "wav":
			throw new Error("WAV is written by the PCM writer, not an OutputFormat");
	}
}

function getNativeCodec({ format }: { format: AudioExportFormat }): AudioCodec {
	switch (format) {
		case "mp3":
			return "mp3";
		case "m4a":
			return "aac";
		case "wav":
			return "pcm-s16";
	}
}

/**
 * M4A's native codec is AAC, but a browser with no AAC encoder can still carry
 * Opus inside MP4. Downgrading beats failing: the user asked for "an audio
 * file" far more often than they asked for AAC specifically. MP3 has no such
 * fallback — if LAME did not register there is nothing else to try.
 */
async function resolveAudioCodec({
	format,
	channels,
	sampleRate,
	bitrate,
}: {
	format: AudioExportFormat;
	channels: number;
	sampleRate: number;
	bitrate: number;
}): Promise<AudioCodec> {
	const codec = getNativeCodec({ format });
	const canEncode = (candidate: AudioCodec) =>
		canEncodeAudio(candidate, {
			numberOfChannels: channels,
			sampleRate,
			bitrate,
		});

	// Order matters for MP3: `canEncodeAudio("mp3")` only returns true once the
	// custom encoder is in the registry, so registering has to precede the probe.
	if (codec === "mp3") ensureMp3EncoderRegistered();

	if (codec === "aac" && !(await canEncode("aac"))) {
		if (!(await canEncode("opus"))) {
			throw new AudioExportUnsupportedError({
				message: "此浏览器无法编码 AAC 或 Opus 音频，请改用 WAV 或 MP3 导出",
			});
		}
		return "opus";
	}

	if (!(await canEncode(codec))) {
		throw new AudioExportUnsupportedError({
			message: `此浏览器无法以 ${sampleRate} Hz / ${channels} 声道编码 ${codec} 音频`,
		});
	}

	return codec;
}

/**
 * Folds an N-channel buffer down to `numChannels`.
 *
 * The mixer always produces stereo, so today the only conversion that happens
 * is stereo → mono, and it is an equal-weight average rather than a channel
 * drop: a voiceover recorded on one side of a stereo pair would otherwise come
 * out of a mono export silent.
 */
function downmixBuffer({
	audioBuffer,
	numChannels,
}: {
	audioBuffer: AudioBuffer;
	numChannels: number;
}): AudioBuffer {
	if (audioBuffer.numberOfChannels === numChannels) return audioBuffer;

	const context = new OfflineAudioContext(
		numChannels,
		Math.max(1, audioBuffer.length),
		audioBuffer.sampleRate,
	);
	const output = context.createBuffer(
		numChannels,
		audioBuffer.length,
		audioBuffer.sampleRate,
	);

	const sourceChannelCount = audioBuffer.numberOfChannels;
	const sources: Float32Array[] = [];
	for (let channel = 0; channel < sourceChannelCount; channel++) {
		sources.push(audioBuffer.getChannelData(channel));
	}

	const gain = 1 / sourceChannelCount;
	for (let target = 0; target < numChannels; target++) {
		const targetData = output.getChannelData(target);
		for (let i = 0; i < targetData.length; i++) {
			let sum = 0;
			for (let channel = 0; channel < sourceChannelCount; channel++) {
				sum += sources[channel][i];
			}
			targetData[i] = sum * gain;
		}
	}

	return output;
}

function buildResult({
	blob,
	format,
}: {
	blob: Blob;
	format: AudioExportFormat;
}): AudioExportResult {
	return {
		blob,
		mimeType: getAudioExportMimeType({ format }),
		extension: getAudioExportFileExtension({ format }),
	};
}

/**
 * Encodes an already-mixed buffer into the requested audio container.
 *
 * Split from `exportTimelineAudio` so the encoding half can be exercised
 * without a project, a timeline, or Web Audio decoding of media assets.
 */
export async function createTimelineAudioBlob({
	audioBuffer,
	format,
	channels,
	sampleRate,
	bitrate,
	onProgress,
}: {
	audioBuffer: AudioBuffer;
	format: AudioExportFormat;
	channels: AudioChannelLayout;
	sampleRate: number;
	bitrate: number;
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<AudioExportResult> {
	// The mixer accepts a target rate, but nothing type-level forces a caller to
	// mix at the same rate it asks to encode: `AudioBufferSource` only rejects
	// *inconsistent* buffers, so a single mismatched buffer would sail through
	// and produce a file whose header advertises a rate the samples do not have.
	if (audioBuffer.sampleRate !== sampleRate) {
		throw new Error(
			`Audio buffer is ${audioBuffer.sampleRate} Hz but ${sampleRate} Hz was requested`,
		);
	}

	const channelCount = getAudioChannelCount({ channels });
	const prepared = downmixBuffer({ audioBuffer, numChannels: channelCount });

	if (format === "wav") {
		onProgress?.({ progress: 0.5 });
		const samples = interleaveAudioBuffer({
			audioBuffer: prepared,
			numChannels: channelCount,
		});
		const blob = createWavBlob({
			samples,
			sampleRate,
			numChannels: channelCount,
		});
		onProgress?.({ progress: 1 });
		return buildResult({ blob, format });
	}

	const codec = await resolveAudioCodec({
		format,
		channels: channelCount,
		sampleRate,
		bitrate,
	});

	onProgress?.({ progress: 0.1 });

	const output = new Output({
		format: createOutputFormat({ format }),
		target: new BufferTarget(),
	});
	const audioSource = new AudioBufferSource({ codec, bitrate });
	output.addAudioTrack(audioSource);

	await output.start();

	// The whole timeline arrives as one buffer, and `add` places the first
	// buffer at 0, so no offset handling is needed here. This is also why
	// exporting a *selection* cannot simply pass a start time: timestamps
	// accumulate from the previous buffers' total duration, so a range export
	// has to hand the encoder an already-trimmed buffer instead.
	await audioSource.add(prepared);
	audioSource.close();

	await output.finalize();
	onProgress?.({ progress: 1 });

	const buffer = output.target.buffer;
	if (!buffer) {
		throw new Error("音频导出未能生成文件");
	}

	return buildResult({
		blob: new Blob([buffer], { type: getAudioExportMimeType({ format }) }),
		format,
	});
}

/**
 * Timeline → standalone audio file. Mirrors `extractTimelineAudio`, but with
 * the container and audio parameters under caller control.
 *
 * Deliberately not folded into `extractTimelineAudio`: that function feeds
 * transcription and must stay 44.1kHz/stereo/WAV, while this one produces a
 * file the user keeps. Sharing them would mean one contract serving two
 * opposite sets of requirements.
 */
export async function exportTimelineAudio({
	tracks,
	mediaAssets,
	totalDuration,
	format,
	channels,
	sampleRate,
	bitrate,
	range,
	onProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDuration: number;
	format: AudioExportFormat;
	channels: AudioChannelLayout;
	sampleRate: number;
	bitrate: number;
	/**
	 * Same sub-range the video export uses, in timeline ticks. Without this a
	 * range export would produce a video of the selection next to an audio file
	 * of the entire project — the two artifacts would cover different spans.
	 *
	 * Note the shape difference from `ExportOptions.range`, which carries
	 * `MediaTime`s: converted at the boundary in `resolveAudioExportRange`
	 * rather than imported, so this module stays free of `@/wasm`.
	 */
	range?: { start: number; end: number };
	onProgress?: ({ progress }: { progress: number }) => void;
}): Promise<AudioExportResult> {
	const rangeTicks = resolveAudioExportRange({ range, totalDuration });

	if (rangeTicks.durationTicks === 0) {
		throw new Error("项目为空，没有可导出的音频");
	}

	onProgress?.({ progress: 0.02 });

	// Mixing straight to the requested rate keeps the encoder from having to
	// resample, and the per-clip resampling the mixer already does is the
	// high-quality offline kind.
	const audioBuffer = await createTimelineAudioBuffer({
		tracks,
		mediaAssets,
		duration: totalDuration,
		sampleRate,
		// The mixer subtracts this range's start in the sample domain, so the
		// buffer comes back already rebased onto the range's zero. That is what
		// lets the encoder below stay offset-free: `AudioBufferSource.add()`
		// timestamps the first buffer at 0 and has no way to place one later.
		range: rangeTicks.range,
	});

	if (!audioBuffer) {
		// A project with no audio still exports. A correctly formed, correctly
		// timed silent file is more useful downstream than an error, and it
		// matches what the video export does with an empty audio track.
		const silentDurationSeconds =
			getSilentDurationTicks({ durationTicks: rangeTicks.durationTicks }) /
			TICKS_PER_SECOND;
		const silentFrameCount = Math.max(
			1,
			Math.ceil(silentDurationSeconds * sampleRate),
		);
		const channelCount = getAudioChannelCount({ channels });
		const silentContext = new OfflineAudioContext(
			channelCount,
			silentFrameCount,
			sampleRate,
		);
		return createTimelineAudioBlob({
			audioBuffer: silentContext.createBuffer(
				channelCount,
				silentFrameCount,
				sampleRate,
			),
			format,
			channels,
			sampleRate,
			bitrate,
			onProgress,
		});
	}

	onProgress?.({ progress: 0.5 });

	return createTimelineAudioBlob({
		audioBuffer,
		format,
		channels,
		sampleRate,
		bitrate,
		onProgress: ({ progress }) =>
			onProgress?.({ progress: 0.5 + progress * 0.5 }),
	});
}
