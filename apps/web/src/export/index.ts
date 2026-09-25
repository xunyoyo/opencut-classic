import type { FrameRate } from "opencut-wasm";
import type { MediaTime } from "@/wasm";
import { AUDIO_EXPORT_MIME_TYPES, EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export const AUDIO_EXPORT_FORMAT_VALUES = ["mp3", "wav", "m4a"] as const;

export const AUDIO_CHANNEL_VALUES = ["mono", "stereo"] as const;

export const AUDIO_SAMPLE_RATE_VALUES = [44100, 48000] as const;

export const AUDIO_BITRATE_VALUES = [128000, 192000, 320000] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];
export type AudioExportFormat = (typeof AUDIO_EXPORT_FORMAT_VALUES)[number];
export type AudioChannelLayout = (typeof AUDIO_CHANNEL_VALUES)[number];
export type AudioSampleRate = (typeof AUDIO_SAMPLE_RATE_VALUES)[number];
export type AudioBitrate = (typeof AUDIO_BITRATE_VALUES)[number];

export interface AudioExportOptions {
	enabled: boolean;
	format: AudioExportFormat;
	channels: AudioChannelLayout;
	sampleRate: AudioSampleRate;
	/** Ignored by `wav`, which is PCM and therefore has no bitrate to pick. */
	bitrate: AudioBitrate;
}

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	/**
	 * Whether the *video* file should carry an audio track. This is not the
	 * switch for the standalone audio file — that is `audio.enabled`. The two
	 * are deliberately independent: a user can hand off a silent master
	 * (video) alongside a separate voiceover stem (audio), or burn the mix into
	 * the video and still want a portable MP3 of it.
	 */
	includeAudio?: boolean;
	/**
	 * Restricts the export to a span of the timeline. Omit to export everything.
	 *
	 * The resulting video starts at the range's content: the exporter rebases
	 * timestamps so the range start maps to the file's zero.
	 */
	range?: { start: MediaTime; end: MediaTime };
	audio?: AudioExportOptions;
}

export interface AudioExportResult {
	blob: Blob;
	mimeType: string;
	extension: string;
}

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
	/**
	 * Populated only when the caller asked for the standalone audio file, which
	 * is produced independently of the video mux. Kept as a `Blob` rather than
	 * an `ArrayBuffer`: the audio encoders hand back blobs already, and nothing
	 * downstream needs the raw bytes.
	 */
	audio?: AudioExportResult;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function getAudioExportMimeType({
	format,
}: {
	format: AudioExportFormat;
}): string {
	return AUDIO_EXPORT_MIME_TYPES[format];
}

export function getAudioExportFileExtension({
	format,
}: {
	format: AudioExportFormat;
}): string {
	return `.${format}`;
}

/**
 * The only place the "mono/stereo" UI vocabulary becomes a channel count. The
 * encoders and the mixer both speak integers, so keeping the translation in one
 * function means a new layout can't be added to the union without landing here.
 */
export function getAudioChannelCount({
	channels,
}: {
	channels: AudioChannelLayout;
}): number {
	return channels === "mono" ? 1 : 2;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
