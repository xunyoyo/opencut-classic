"use client";

import { useState } from "react";
import { TransitionTopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/utils/ui";
import { downloadBlob } from "@/utils/browser";
import { createZip } from "@/export/zip";
import {
	getExportMimeType,
	getExportFileExtension,
	downloadBuffer,
} from "@/export";
import { Check, Copy, Download, RotateCcw } from "lucide-react";
import { formatTimecode } from "opencut-wasm";
import {
	EXPORT_FORMAT_VALUES,
	EXPORT_QUALITY_VALUES,
	AUDIO_EXPORT_FORMAT_VALUES,
	AUDIO_CHANNEL_VALUES,
	AUDIO_SAMPLE_RATE_VALUES,
	AUDIO_BITRATE_VALUES,
	type ExportFormat,
	type ExportQuality,
	type AudioExportFormat,
	type AudioChannelLayout,
	type AudioSampleRate,
	type AudioBitrate,
} from "@/export";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import {
	clampRangeToDuration,
	useExportRange,
	useTimeRangeStore,
} from "@/timeline/time-range";

function isExportFormat(value: string): value is ExportFormat {
	return EXPORT_FORMAT_VALUES.some((formatValue) => formatValue === value);
}

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((qualityValue) => qualityValue === value);
}

function isAudioExportFormat(value: string): value is AudioExportFormat {
	return AUDIO_EXPORT_FORMAT_VALUES.some(
		(formatValue) => formatValue === value,
	);
}

function isAudioChannelLayout(value: string): value is AudioChannelLayout {
	return AUDIO_CHANNEL_VALUES.some((channelValue) => channelValue === value);
}

function isAudioSampleRate(value: number): value is AudioSampleRate {
	return AUDIO_SAMPLE_RATE_VALUES.some((rate) => rate === value);
}

function isAudioBitrate(value: number): value is AudioBitrate {
	return AUDIO_BITRATE_VALUES.some((bitrate) => bitrate === value);
}

/**
 * Hands the finished artifacts to the user as a single download.
 *
 * One artifact downloads as itself. Two or more are packed into one ZIP and
 * downloaded with a *single* `a.click()` — a second programmatic click in the
 * same gesture is what Safari throttles or drops outright, and the failure mode
 * is silent (the user gets the first file and believes the export succeeded).
 *
 * A single artifact is deliberately not wrapped in a ZIP: a lone `xxx.zip`
 * containing one `xxx.mp4` is worse than the plain file, because every
 * downstream step then starts with an unzip.
 */
async function downloadExportArtifacts({
	projectName,
	video,
	audio,
}: {
	projectName: string;
	video: { buffer: ArrayBuffer; filename: string; mimeType: string };
	audio: { blob: Blob; filename: string } | null;
}) {
	if (!audio) {
		downloadBuffer({
			buffer: video.buffer,
			filename: video.filename,
			mimeType: video.mimeType,
		});
		return;
	}

	const zip = await createZip({
		entries: [
			{
				name: video.filename,
				data: new Blob([video.buffer], { type: video.mimeType }),
			},
			{ name: audio.filename, data: audio.blob },
		],
	});

	downloadBlob({ blob: zip, filename: `${projectName}.zip` });
}

export function ExportButton() {
	const [isExportPopoverOpen, setIsExportPopoverOpen] = useState(false);
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const hasProject = !!activeProject;

	const handlePopoverOpenChange = ({ open }: { open: boolean }) => {
		if (!open) {
			editor.project.cancelExport();
			editor.project.clearExportState();
		}
		setIsExportPopoverOpen(open);
	};

	return (
		<Popover
			open={isExportPopoverOpen}
			onOpenChange={(open) => handlePopoverOpenChange({ open })}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={cn(
						"flex items-center gap-1.5 rounded-md bg-[#38BDF8] px-[0.12rem] py-[0.12rem] text-white",
						hasProject ? "cursor-pointer" : "cursor-not-allowed opacity-50",
					)}
					onClick={hasProject ? () => setIsExportPopoverOpen(true) : undefined}
					disabled={!hasProject}
					onKeyDown={(event) => {
						if (hasProject && (event.key === "Enter" || event.key === " ")) {
							event.preventDefault();
							setIsExportPopoverOpen(true);
						}
					}}
				>
					<div className="relative flex items-center gap-1.5 rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7] px-4 py-1 shadow-[0_1px_3px_0px_rgba(0,0,0,0.65)]">
						<HugeiconsIcon icon={TransitionTopIcon} className="z-50 size-3.5" />
						<span className="z-50 text-[0.875rem]">导出</span>
						<div className="absolute top-0 left-0 z-10 flex size-full items-center justify-center rounded-[0.6rem] bg-linear-to-t from-white/0 to-white/50">
							<div className="absolute top-[0.08rem] z-50 h-[calc(100%-2px)] w-[calc(100%-2px)] rounded-[0.6rem] bg-linear-270 from-[#2567EC] to-[#37B6F7]"></div>
						</div>
					</div>
				</button>
			</PopoverTrigger>
			{hasProject && <ExportPopover onOpenChange={setIsExportPopoverOpen} />}
		</Popover>
	);
}

function ExportPopover({
	onOpenChange,
}: {
	onOpenChange: (open: boolean) => void;
}) {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const exportState = useEditor((e) => e.project.getExportState());
	const { isExporting, progress, result: exportResult } = exportState;
	const [format, setFormat] = useState<ExportFormat>(
		DEFAULT_EXPORT_OPTIONS.format,
	);
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [shouldIncludeAudio, setShouldIncludeAudio] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.includeAudio ?? true,
	);
	const [shouldExportAudioFile, setShouldExportAudioFile] = useState<boolean>(
		DEFAULT_EXPORT_OPTIONS.audio?.enabled ?? false,
	);
	const [audioFormat, setAudioFormat] = useState<AudioExportFormat>(
		DEFAULT_EXPORT_OPTIONS.audio?.format ?? "mp3",
	);
	const [audioChannels, setAudioChannels] = useState<AudioChannelLayout>(
		DEFAULT_EXPORT_OPTIONS.audio?.channels ?? "stereo",
	);
	const [audioSampleRate, setAudioSampleRate] = useState<AudioSampleRate>(
		DEFAULT_EXPORT_OPTIONS.audio?.sampleRate ?? 48000,
	);
	const [audioBitrate, setAudioBitrate] = useState<AudioBitrate>(
		DEFAULT_EXPORT_OPTIONS.audio?.bitrate ?? 192000,
	);
	// Null when there is no selection (or a degenerate one), so the button below
	// can distinguish "export everything" from "export what I framed".
	const exportRange = useExportRange();
	const clearExportRange = useTimeRangeStore((state) => state.clearRange);

	const handleExport = async () => {
		if (!activeProject) return;

		// Clamp at the moment of export: the range was drawn against an earlier
		// state of the timeline, and deleting a trailing element shortens it.
		// The exporter clamps too, as a backstop, but resolving it here means the
		// UI's stated bounds and the encoded output agree.
		const exportableRange = exportRange
			? clampRangeToDuration({
					range: exportRange,
					duration: editor.timeline.getTotalDuration(),
				})
			: null;

		const result = await editor.project.export({
			options: {
				format,
				quality,
				fps: activeProject.settings.fps,
				includeAudio: shouldIncludeAudio,
				// Read at call time rather than render time: the popover may have
				// been opened before the range was drawn, and a stale undefined
				// here would silently export the whole timeline.
				range: exportableRange ?? undefined,
				audio: {
					enabled: shouldExportAudioFile,
					format: audioFormat,
					channels: audioChannels,
					sampleRate: audioSampleRate,
					bitrate: audioBitrate,
				},
			},
		});

		if (result.cancelled) {
			editor.project.clearExportState();
			return;
		}

		if (result.success && result.buffer) {
			// Single exit for every artifact. When a standalone audio file was
			// asked for, video and audio leave together as one download — two
			// programmatic clicks in one gesture is the Safari case that drops
			// the second file silently.
			await downloadExportArtifacts({
				projectName: activeProject.metadata.name,
				video: {
					buffer: result.buffer,
					filename: `${activeProject.metadata.name}${getExportFileExtension({ format })}`,
					mimeType: getExportMimeType({ format }),
				},
				audio: result.audio
					? {
							blob: result.audio.blob,
							filename: `${activeProject.metadata.name}${result.audio.extension}`,
						}
					: null,
			});

			editor.project.clearExportState();
			onOpenChange(false);
		}
	};

	const handleCancel = () => {
		editor.project.cancelExport();
	};

	return (
		<PopoverContent className="bg-background mr-4 flex w-80 flex-col p-0">
			{exportResult && !exportResult.success ? (
				<ExportError
					error={exportResult.error || "发生未知错误"}
					onRetry={handleExport}
				/>
			) : (
				<>
					<div className="flex items-center justify-between p-3 border-b">
						<h3 className="font-medium text-sm">
							{isExporting ? "正在导出项目" : "导出项目"}
						</h3>
					</div>

					<div className="flex flex-col gap-4">
						{!isExporting && (
							<>
								<div className="flex flex-col">
									<Section
										collapsible
										defaultOpen={false}
										showTopBorder={false}
									>
										<SectionHeader>
											<SectionTitle>格式</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={format}
												onValueChange={(value) => {
													if (isExportFormat(value)) {
														setFormat(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="mp4" id="mp4" />
													<Label htmlFor="mp4">MP4 (H.264) - 兼容性更好</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="webm" id="webm" />
													<Label htmlFor="webm">WebM (VP9) - 文件更小</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>画质</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<RadioGroup
												value={quality}
												onValueChange={(value) => {
													if (isExportQuality(value)) {
														setQuality(value);
													}
												}}
											>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="low" id="low" />
													<Label htmlFor="low">低 - 文件最小</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="medium" id="medium" />
													<Label htmlFor="medium">中 - 平衡</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="high" id="high" />
													<Label htmlFor="high">高 - 推荐</Label>
												</div>
												<div className="flex items-center space-x-2">
													<RadioGroupItem value="very_high" id="very_high" />
													<Label htmlFor="very_high">极高 - 文件最大</Label>
												</div>
											</RadioGroup>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>音频</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex items-center space-x-2">
												<Checkbox
													id="include-audio"
													checked={shouldIncludeAudio}
													onCheckedChange={(checked) =>
														setShouldIncludeAudio(!!checked)
													}
												/>
												<Label htmlFor="include-audio">导出时包含音频</Label>
											</div>
										</SectionContent>
									</Section>

									<Section collapsible defaultOpen={false}>
										<SectionHeader>
											<SectionTitle>单独导出音频</SectionTitle>
										</SectionHeader>
										<SectionContent>
											<div className="flex flex-col gap-3">
												<div className="flex items-center space-x-2">
													<Checkbox
														id="export-audio-file"
														checked={shouldExportAudioFile}
														onCheckedChange={(checked) =>
															setShouldExportAudioFile(!!checked)
														}
													/>
													<Label htmlFor="export-audio-file">
														额外生成一个音频文件
													</Label>
												</div>

												{/* The controls below cannot do anything while the
												    checkbox is off, so they are disabled rather than
												    hidden: a user who wants a 48kHz mono MP3 can see
												    the options exist before committing to the export. */}
												{shouldExportAudioFile && (
													<div className="flex flex-col gap-3">
														<div className="flex flex-col gap-2">
															<Label>格式</Label>
															<RadioGroup
																value={audioFormat}
																onValueChange={(value) => {
																	if (isAudioExportFormat(value)) {
																		setAudioFormat(value);
																	}
																}}
															>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem value="mp3" id="audio-mp3" />
																	<Label htmlFor="audio-mp3">
																		MP3 - 兼容性最好
																	</Label>
																</div>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem value="wav" id="audio-wav" />
																	<Label htmlFor="audio-wav">
																		WAV - 无损，文件最大
																	</Label>
																</div>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem value="m4a" id="audio-m4a" />
																	<Label htmlFor="audio-m4a">
																		M4A (AAC) - 文件更小
																	</Label>
																</div>
															</RadioGroup>
														</div>

														<div className="flex flex-col gap-2">
															<Label>声道</Label>
															<RadioGroup
																value={audioChannels}
																onValueChange={(value) => {
																	if (isAudioChannelLayout(value)) {
																		setAudioChannels(value);
																	}
																}}
															>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem
																		value="stereo"
																		id="audio-stereo"
																	/>
																	<Label htmlFor="audio-stereo">立体声</Label>
																</div>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem
																		value="mono"
																		id="audio-mono"
																	/>
																	<Label htmlFor="audio-mono">单声道</Label>
																</div>
															</RadioGroup>
														</div>

														<div className="flex flex-col gap-2">
															<Label>采样率</Label>
															<RadioGroup
																value={String(audioSampleRate)}
																onValueChange={(value) => {
																	const rate = Number(value);
																	if (isAudioSampleRate(rate)) {
																		setAudioSampleRate(rate);
																	}
																}}
															>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem
																		value="48000"
																		id="audio-rate-48000"
																	/>
																	<Label htmlFor="audio-rate-48000">
																		48000 Hz - 推荐
																	</Label>
																</div>
																<div className="flex items-center space-x-2">
																	<RadioGroupItem
																		value="44100"
																		id="audio-rate-44100"
																	/>
																	<Label htmlFor="audio-rate-44100">
																		44100 Hz - CD 音质
																	</Label>
																</div>
															</RadioGroup>
														</div>

														{/* PCM has no bitrate to choose, so the
														    control is hidden rather than shown
														    disabled — an inert radio group reads as
														    a bug. */}
														{audioFormat !== "wav" && (
															<div className="flex flex-col gap-2">
																<Label>比特率</Label>
																<RadioGroup
																	value={String(audioBitrate)}
																	onValueChange={(value) => {
																		const bitrate = Number(value);
																		if (isAudioBitrate(bitrate)) {
																			setAudioBitrate(bitrate);
																		}
																	}}
																>
																	<div className="flex items-center space-x-2">
																		<RadioGroupItem
																			value="128000"
																			id="audio-bitrate-128"
																		/>
																		<Label htmlFor="audio-bitrate-128">
																			128 kbps - 文件最小
																		</Label>
																	</div>
																	<div className="flex items-center space-x-2">
																		<RadioGroupItem
																			value="192000"
																			id="audio-bitrate-192"
																		/>
																		<Label htmlFor="audio-bitrate-192">
																			192 kbps - 推荐
																		</Label>
																	</div>
																	<div className="flex items-center space-x-2">
																		<RadioGroupItem
																			value="320000"
																			id="audio-bitrate-320"
																		/>
																		<Label htmlFor="audio-bitrate-320">
																			320 kbps - 音质最好
																		</Label>
																	</div>
																</RadioGroup>
															</div>
														)}
													</div>
												)}
											</div>
										</SectionContent>
									</Section>
								</div>

								{exportRange && (
									<div className="border-primary/30 bg-primary/5 mx-3 flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
										<div className="flex flex-col">
											<span className="text-xs font-medium">
												仅导出选中区域
											</span>
											<span className="text-muted-foreground text-[11px] tabular-nums">
												{formatTimecode({
													time: exportRange.start,
													format: "HH:MM:SS:FF",
													rate: activeProject.settings.fps,
												})}{" "}
												→{" "}
												{formatTimecode({
													time: exportRange.end,
													format: "HH:MM:SS:FF",
													rate: activeProject.settings.fps,
												})}
											</span>
										</div>
										<button
											type="button"
											className="text-muted-foreground hover:text-foreground text-[11px] underline"
											onClick={() => clearExportRange()}
										>
											取消选定
										</button>
									</div>
								)}

								<div className="p-3 pt-0">
									<Button onClick={handleExport} className="w-full gap-2">
										<Download className="size-4" />
										{exportRange ? "导出选中区域" : "导出"}
									</Button>
								</div>
							</>
						)}

						{isExporting && (
							<div className="space-y-4 p-3">
								<div className="flex flex-col gap-2">
									<div className="flex items-center justify-between text-center">
										<p className="text-muted-foreground text-sm">
											{Math.round(progress * 100)}%
										</p>
										<p className="text-muted-foreground text-sm">100%</p>
									</div>
									<Progress value={progress * 100} className="w-full" />
								</div>

								<Button
									variant="outline"
									className="w-full rounded-md"
									onClick={handleCancel}
								>
									取消
								</Button>
							</div>
						)}
					</div>
				</>
			)}
		</PopoverContent>
	);
}

function ExportError({
	error,
	onRetry,
}: {
	error: string;
	onRetry: () => void;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(error);
		setCopied(true);
		setTimeout(() => setCopied(false), 1000);
	};

	return (
		<div className="space-y-4 p-3">
			<div className="flex flex-col gap-1.5">
				<p className="text-destructive text-sm font-medium">导出失败</p>
				<p className="text-muted-foreground text-xs">{error}</p>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={handleCopy}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					复制
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					重试
				</Button>
			</div>
		</div>
	);
}
