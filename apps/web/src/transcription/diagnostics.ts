import type { DiagnosticsManager } from "@/core/managers/diagnostics-manager";
import { timelineHasAudio } from "@/media/audio";

export const TRANSCRIPTION_DIAGNOSTICS_SCOPE = "transcription";

export function registerTranscriptionDiagnostics({
	diagnostics,
}: {
	diagnostics: DiagnosticsManager;
}): void {
	diagnostics.register({
		id: "transcription.no_audio",
		scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE,
		severity: "caution",
		message: "未检测到音频，先在时间线中添加带音频的片段",
		check: (editor) => {
			const scene = editor.scenes.getActiveSceneOrNull();
			if (!scene) return false;
			return !timelineHasAudio({
				tracks: scene.tracks,
				mediaAssets: editor.media.getAssets(),
			});
		},
	});
}
