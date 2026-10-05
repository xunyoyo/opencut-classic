import type { LanguageCode } from "./languages";

export type TranscriptionLanguage = LanguageCode | "auto";

export interface TranscriptionWord {
	word: string;
	start: number;
	end: number;
}

export interface TranscriptionSegment {
	text: string;
	start: number;
	end: number;
	/**
	 * Word-level timings. The AI-Saturn engine always provides them; the
	 * in-browser engine does when the model was exported for it.
	 */
	words?: TranscriptionWord[];
}

export interface TranscriptionResult {
	text: string;
	segments: TranscriptionSegment[];
	language: string;
}

export type TranscriptionStatus =
	| "idle"
	| "loading-model"
	| "transcribing"
	| "complete"
	| "error";

export interface TranscriptionProgress {
	status: TranscriptionStatus;
	progress: number;
	message?: string;
}

export type TranscriptionModelId =
	| "whisper-tiny"
	| "whisper-small"
	| "whisper-medium"
	| "whisper-large-v3-turbo";

export interface TranscriptionModel {
	id: TranscriptionModelId;
	name: string;
	huggingFaceId: string;
	description: string;
	/**
	 * Whether the export carries the cross-attentions word timestamps are
	 * computed from. Asking a model without them throws.
	 */
	wordTimestamps: boolean;
}

export interface CaptionChunk {
	text: string;
	startTime: number;
	duration: number;
}
