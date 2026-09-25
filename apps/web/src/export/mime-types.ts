export const EXPORT_MIME_TYPES = {
	webm: "video/webm",
	mp4: "video/mp4",
} as const;

// Audio-only artifacts get their own table rather than an entry in
// EXPORT_MIME_TYPES: the video union and the audio union overlap on nothing
// today, but keying them separately keeps `EXPORT_MIME_TYPES[format]` total
// over ExportFormat so a future audio-only format can't silently widen it.
export const AUDIO_EXPORT_MIME_TYPES = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
} as const;
