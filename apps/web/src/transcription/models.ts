import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "./types";

// The "_timestamped" repos hold the same weights (same file sizes) exported with
// cross-attentions, which `return_timestamps: "word"` needs. The plain repos
// fail with "Model outputs must contain cross attentions" (measured
// 2026-10-05, Transformers.js 3.8.1, all four sizes), which left local captions
// placed only on segment timings.
export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "轻量",
		huggingFaceId: "onnx-community/whisper-tiny_timestamped",
		wordTimestamps: true,
		description: "速度最快，精度较低",
	},
	{
		id: "whisper-small",
		name: "标准",
		huggingFaceId: "onnx-community/whisper-small_timestamped",
		wordTimestamps: true,
		description: "速度与精度均衡",
	},
	{
		id: "whisper-medium",
		name: "高精度",
		// Not "onnx-community/whisper-medium", a different repo that 401s and
		// made this the one tier that could never finish downloading.
		huggingFaceId: "onnx-community/whisper-medium_timestamped",
		wordTimestamps: true,
		description: "精度更高，速度较慢",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "最高精度",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo_timestamped",
		wordTimestamps: true,
		description: "精度最高，需要WebGPU才能获得良好性能",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";
