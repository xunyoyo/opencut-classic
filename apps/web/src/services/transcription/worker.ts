import {
	env,
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type { TranscriptionSegment } from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
	DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
} from "@/transcription/audio";
import {
	leadingSilenceSeconds,
	placeWindowWords,
	planTranscriptionWindows,
	segmentsFromSegmentChunks,
	segmentsFromWordChunks,
	wordTimingsLookUsable,
} from "@/transcription/whisper-chunks";

// huggingface.co is unreachable from mainland China. The host is configurable
// so a deployment can serve the weights from its own CDN or OSS bucket rather
// than depending on a public mirror; hf-mirror.com stays the fallback because
// it mirrors huggingface.co's resolve path structure exactly.
//
// These read process.env directly instead of going through @/env/web: this
// module runs in a worker, and that one parses the full server-side schema.
// Next.js inlines NEXT_PUBLIC_* at build time, so the values still arrive here.
env.remoteHost =
	process.env.NEXT_PUBLIC_TRANSCRIPTION_MODEL_HOST ?? "https://hf-mirror.com/";

// Only override when set — a flat object-storage layout won't have the
// "{model}/resolve/{revision}" path that the default template assumes.
if (process.env.NEXT_PUBLIC_TRANSCRIPTION_MODEL_PATH_TEMPLATE) {
	env.remotePathTemplate =
		process.env.NEXT_PUBLIC_TRANSCRIPTION_MODEL_PATH_TEMPLATE;
}

export type WorkerMessage =
	| { type: "init"; modelId: string; wordTimestamps: boolean }
	| { type: "transcribe"; audio: Float32Array; language: string }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let wordTimestamps = false;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({
				modelId: message.modelId,
				wordTimestamps: message.wordTimestamps,
			});
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

async function handleInit({
	modelId,
	wordTimestamps: supportsWords,
}: {
	modelId: string;
	wordTimestamps: boolean;
}) {
	lastReportedProgress = -1;
	fileBytes.clear();
	wordTimestamps = supportsWords;

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "模型加载失败",
		} satisfies WorkerResponse);
	}
}

async function handleTranscribe({
	audio,
	language: requested,
}: {
	audio: Float32Array;
	language: string;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "模型尚未加载",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	try {
		const audioDuration = audio.length / DEFAULT_TRANSCRIPTION_SAMPLE_RATE;
		const language = requested === "auto" ? undefined : requested;

		const args = { pipe: transcriber, audio, audioDuration, language };

		let result = wordTimestamps ? await transcribeWords(args) : null;
		if (cancelled) return;
		result ??= await transcribeSegments(args);
		if (cancelled) return;
		const { text, segments } = result;

		self.postMessage({
			type: "transcribe-complete",
			text,
			segments,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "转录失败",
		} satisfies WorkerResponse);
	}
}

interface TranscribeArgs {
	pipe: AutomaticSpeechRecognitionPipeline;
	audio: Float32Array;
	language: string | undefined;
}

interface TranscribeResult {
	text: string;
	segments: TranscriptionSegment[];
}

function firstOutput(
	output: AutomaticSpeechRecognitionOutput | AutomaticSpeechRecognitionOutput[],
): AutomaticSpeechRecognitionOutput {
	return Array.isArray(output) ? output[0] : output;
}

/**
 * Word timings, one pause-cut window at a time (see
 * `planTranscriptionWindows` for why not the pipeline's own chunking). A
 * window whose alignment is unusable is transcribed again with segment
 * timings. Null when the model can not align words at all, so the caller
 * falls back to segment timings for the whole clip.
 */
async function transcribeWords({
	pipe,
	audio,
	language,
}: TranscribeArgs): Promise<TranscribeResult | null> {
	const windows = planTranscriptionWindows({
		audio,
		sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
	});
	const segments: TranscriptionSegment[] = [];
	let text = "";

	for (const [index, window] of windows.entries()) {
		if (cancelled) return null;
		const windowAudio = audio.subarray(window.start, window.end);
		const offsetSeconds = window.start / DEFAULT_TRANSCRIPTION_SAMPLE_RATE;
		const windowDuration = windowAudio.length / DEFAULT_TRANSCRIPTION_SAMPLE_RATE;

		let output: AutomaticSpeechRecognitionOutput;
		try {
			output = firstOutput(
				await pipe(windowAudio, { language, return_timestamps: "word" }),
			);
		} catch (error) {
			console.warn("词级时间戳不可用，改用分段时间戳", error);
			return null;
		}

		const chunks = output.chunks ?? [];
		if (wordTimingsLookUsable({ chunks, audioDuration: windowDuration })) {
			text += output.text;
			segments.push(
				...segmentsFromWordChunks({
					chunks: placeWindowWords({ chunks, offsetSeconds }),
					audioDuration: offsetSeconds + windowDuration,
				}),
			);
		} else if (output.text.trim()) {
			console.warn("这一段词级时间戳不可信，改用分段时间戳");
			const fallback = await transcribeSegments({
				pipe,
				audio: windowAudio,
				language,
			});
			text += fallback.text;
			segments.push(
				...fallback.segments.map((segment) => ({
					...segment,
					start: segment.start + offsetSeconds,
					end: segment.end + offsetSeconds,
				})),
			);
		}

		self.postMessage({
			type: "transcribe-progress",
			progress: Math.round(((index + 1) / windows.length) * 100),
		} satisfies WorkerResponse);
	}

	return { text: text.trim(), segments };
}

async function transcribeSegments({
	pipe,
	audio,
	language,
}: TranscribeArgs): Promise<TranscribeResult> {
	const output = firstOutput(
		await pipe(audio, {
			chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
			stride_length_s: DEFAULT_STRIDE_SECONDS,
			language,
			return_timestamps: true,
		}),
	);
	return {
		text: output.text,
		segments: segmentsFromSegmentChunks({
			chunks: output.chunks ?? [],
			audioDuration: audio.length / DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
			speechStart: leadingSilenceSeconds({
				audio,
				sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
			}),
		}),
	};
}
