/**
 * Where transcription runs.
 *
 * "local" is Whisper in a worker via Transformers.js: no server, no cost, but
 * the first run downloads a few hundred megabytes of weights and then pins a
 * core for the length of the audio.
 *
 * "remote" hands the audio to AI-Saturn, which calls whatever speech service
 * it is configured for. Fast and cheap on the client, but it needs the user's
 * AI-Saturn session and it sends their audio to a server.
 */
export type TranscriptionEngine = "local" | "remote";

export const TRANSCRIPTION_ENGINE_LABELS: Record<TranscriptionEngine, string> =
	{
		local: "本地转录",
		remote: "在线转录",
	};

/**
 * Whether the remote engine should be offered at all.
 *
 * Deployments without an AI-Saturn transcription endpoint leave the flag unset
 * and see the local-only behaviour they had before.
 */
export function isRemoteTranscriptionEnabled(): boolean {
	return process.env.NEXT_PUBLIC_TRANSCRIPTION_REMOTE_ENABLED === "true";
}

/**
 * Remote when it is available: configuring the endpoint is the opt-in, and the
 * reason to do it is to stop every user downloading Whisper.
 */
export function getDefaultTranscriptionEngine(): TranscriptionEngine {
	return isRemoteTranscriptionEnabled() ? "remote" : "local";
}
