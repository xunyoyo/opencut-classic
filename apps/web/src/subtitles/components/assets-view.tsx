import { Button } from "@/components/ui/button";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEffect, useReducer, useRef, useState } from "react";
import { extractTimelineAudio } from "@/media/mediabunny";
import { useEditor } from "@/editor/use-editor";
import { TRANSCRIPTION_DIAGNOSTICS_SCOPE } from "@/transcription/diagnostics";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionProgress,
} from "@/transcription/types";
import { transcriptionService } from "@/services/transcription/service";
import { transcribeRemote } from "@/services/transcription/remote";
import { fetchSaturnPoints, type SaturnPoints } from "@/saturn/points";
import {
	TRANSCRIPTION_ENGINE_LABELS,
	getDefaultTranscriptionEngine,
	isRemoteTranscriptionEnabled,
	type TranscriptionEngine,
} from "@/transcription/engines";
import { decodeAudioToFloat32 } from "@/media/audio";
import { buildCaptionChunks } from "@/transcription/caption";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { Spinner } from "@/components/ui/spinner";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { AlertCircleIcon, CloudUploadIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiagnosticSeverity } from "@/diagnostics/types";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";

const DIAGNOSTIC_BUTTON_VARIANT: Record<
	DiagnosticSeverity,
	"caution" | "destructive-foreground"
> = {
	caution: "caution",
	error: "destructive-foreground",
};

type ProcessingState =
	| { status: "idle"; error: string | null; warnings: string[] }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[] }
	| { type: "fail"; error: string };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
};

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return { status: "idle", error: null, warnings: action.warnings };
		case "fail":
			return { status: "idle", error: action.error, warnings: [] };
	}
}
/* eslint-enable opencut/prefer-object-params */

export function Captions() {
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [engine, setEngine] = useState<TranscriptionEngine>(
		getDefaultTranscriptionEngine,
	);
	const [points, setPoints] = useState<SaturnPoints | null>(null);
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();
	const pendingAutoCaption = useAssetsPanelStore(
		(state) => state.pendingAutoCaption,
	);
	const clearAutoCaption = useAssetsPanelStore(
		(state) => state.clearAutoCaption,
	);

	const isProcessing = processing.status === "processing";

	const activeDiagnostics = useEditor((e) =>
		e.diagnostics.getActive({ scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE }),
	);

	const handleProgress = (progress: TranscriptionProgress) => {
		if (progress.status === "loading-model") {
			dispatch({
				type: "update_step",
				step: `正在加载模型${Math.round(progress.progress)}%`,
			});
		} else if (progress.status === "transcribing") {
			dispatch({ type: "update_step", step: "转录中" });
		}
	};

	// Only meaningful for the online engine, which spends 土豆 per run.
	useEffect(() => {
		if (engine !== "remote") return;
		const controller = new AbortController();
		void fetchSaturnPoints({ signal: controller.signal }).then(setPoints);
		return () => controller.abort();
	}, [engine]);

	const insertCaptions = ({
		captions,
	}: {
		captions: CaptionChunk[];
	}): boolean => {
		const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
		return trackId !== null;
	};

	const handleGenerateTranscript = async () => {
		dispatch({ type: "start", step: "提取音频中" });
		try {
			const audioBlob = await extractTimelineAudio({
				tracks: editor.scenes.getActiveScene().tracks,
				mediaAssets: editor.media.getAssets(),
				totalDuration: editor.timeline.getTotalDuration(),
			});

			// The remote engine wants a file, so the decode to Float32 samples is
			// skipped entirely on that path — it is the slowest main-thread step
			// here and nothing downstream would use the result.
			const result =
				engine === "remote"
					? await transcribeRemote({
							audioBlob,
							language: selectedLanguage,
							onProgress: handleProgress,
						})
					: await (async () => {
							dispatch({ type: "update_step", step: "准备音频中" });
							const { samples } = await decodeAudioToFloat32({
								audioBlob,
								sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
							});
							return transcriptionService.transcribe({
								audioData: samples,
								language:
									selectedLanguage === "auto" ? undefined : selectedLanguage,
								onProgress: handleProgress,
							});
						})();

			dispatch({ type: "update_step", step: "生成字幕中" });
			const captionChunks = buildCaptionChunks({ segments: result.segments });

			if (!insertCaptions({ captions: captionChunks })) {
				dispatch({ type: "fail", error: "未生成字幕" });
				return;
			}

			dispatch({ type: "succeed", warnings: [] });
			// The run just cost 土豆; show what is left rather than a stale figure.
			if (engine === "remote") {
				void fetchSaturnPoints().then(setPoints);
			}
		} catch (error) {
			console.error("Transcription failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: "发生意外错误",
			});
		}
	};

	// The AI-Saturn importer lands the user directly on this view and wants
	// captions generated without a click. The ref guard is load-bearing:
	// handleGenerateTranscript is rebuilt on every render and the flag clears
	// asynchronously, so without it a re-render mid-download would start a
	// second transcription on top of the first.
	const hasAutoStarted = useRef(false);
	useEffect(() => {
		if (!pendingAutoCaption || hasAutoStarted.current) return;
		hasAutoStarted.current = true;
		clearAutoCaption();
		void handleGenerateTranscript();
		// Intentionally keyed on the request flag alone — the ref above already
		// guarantees a single run, so re-running on handler identity would only
		// risk duplicate transcriptions.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pendingAutoCaption]);

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: "读取字幕文件中" });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({
				fileName: file.name,
				input,
			});

			if (result.captions.length === 0) {
				dispatch({
					type: "fail",
					error: "字幕文件中未找到有效字幕",
				});
				return;
			}

			dispatch({ type: "update_step", step: "导入字幕中" });

			if (!insertCaptions({ captions: result.captions })) {
				dispatch({ type: "fail", error: "未生成字幕" });
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					`已导入${result.captions.length}条字幕，跳过了${result.skippedCueCount}条格式错误的字幕`,
				);
			}

			dispatch({ type: "succeed", warnings: nextWarnings });
		} catch (error) {
			console.error("Subtitle import failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: "发生意外错误",
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		if (event.target) {
			event.target.value = "";
		}
		if (!file) return;

		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}

		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (!matchedLanguage) return;
		setSelectedLanguage(matchedLanguage.code);
	};

	const error = processing.status === "idle" ? processing.error : null;
	const warnings = processing.status === "idle" ? processing.warnings : [];

	return (
		<PanelView
			title="字幕"
			contentClassName="px-0 flex flex-col h-full"
			actions={
				<TooltipProvider>
					<div className="flex items-center gap-1.5">
						{!isProcessing &&
							activeDiagnostics.map((diagnostic) => (
								<Tooltip key={diagnostic.id}>
									<TooltipTrigger asChild>
										<Button
											variant={DIAGNOSTIC_BUTTON_VARIANT[diagnostic.severity]}
											size="icon"
											aria-label={diagnostic.message}
										>
											<HugeiconsIcon icon={AlertCircleIcon} size={16} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{diagnostic.message}</TooltipContent>
								</Tooltip>
							))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleImportClick}
							disabled={isProcessing}
							className="items-center justify-center gap-1.5"
						>
							<HugeiconsIcon icon={CloudUploadIcon} />
							导入
						</Button>
					</div>
				</TooltipProvider>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section
				showTopBorder={false}
				showBottomBorder={false}
				className="flex-1"
			>
				<SectionContent className="flex flex-col gap-4 h-full pt-1">
					<SectionFields>
						{isRemoteTranscriptionEnabled() && (
								<SectionField label="转录方式">
									<Select
										value={engine}
										onValueChange={(value) =>
											setEngine(value === "remote" ? "remote" : "local")
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="remote">
												{TRANSCRIPTION_ENGINE_LABELS.remote}
											</SelectItem>
											<SelectItem value="local">
												{TRANSCRIPTION_ENGINE_LABELS.local}
											</SelectItem>
										</SelectContent>
									</Select>
								</SectionField>
							)}
							<SectionField label="语言">
							<Select
								value={selectedLanguage}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder="选择语言" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">自动检测</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{language.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					{engine === "remote" && points && (
						<p className="text-muted-foreground text-xs">
							可用土豆 {points.available}
							{points.frozen > 0 && `，冻结中 ${points.frozen}`}
						</p>
					)}

					<Button
						type="button"
						className="mt-auto w-full"
						onClick={handleGenerateTranscript}
						disabled={isProcessing || activeDiagnostics.length > 0}
					>
						{isProcessing && <Spinner className="mr-1" />}
						{isProcessing ? processing.step : "生成转录文本"}
					</Button>
					{error && (
						<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}
					{warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
							<ul className="space-y-1 text-sm text-amber-700">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}
