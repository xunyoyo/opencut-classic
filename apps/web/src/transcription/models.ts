import type {
	TranscriptionModel,
	TranscriptionModelId,
} from "./types";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "轻量",
		huggingFaceId: "onnx-community/whisper-tiny",
		description: "速度最快，精度较低",
	},
	{
		id: "whisper-small",
		name: "标准",
		huggingFaceId: "onnx-community/whisper-small",
		description: "速度与精度均衡",
	},
	{
		id: "whisper-medium",
		name: "高精度",
		// The ONNX weights live under a "-ONNX" suffix for this size only;
		// "onnx-community/whisper-medium" is a different repo that 401s, which
		// made this the one tier that could never finish downloading.
		huggingFaceId: "onnx-community/whisper-medium-ONNX",
		description: "精度更高，速度较慢",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "最高精度",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		description: "精度最高，需要WebGPU才能获得良好性能",
	},
];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-small";
