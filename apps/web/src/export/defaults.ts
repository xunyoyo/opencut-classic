import type { ExportOptions } from "./index";

export const DEFAULT_EXPORT_OPTIONS = {
	format: "mp4",
	quality: "high",
	includeAudio: true,
	audio: {
		// Off by default. Most exports are a video handoff, and a second file
		// appearing unasked for is a surprise; the user opts into a separate
		// audio artifact explicitly.
		enabled: false,
		// MP3 is the format the customer QA asked for by name, so it is the one
		// a user gets without having to think about codecs.
		format: "mp3",
		channels: "stereo",
		sampleRate: 48000,
		bitrate: 192000,
	},
} satisfies ExportOptions;
