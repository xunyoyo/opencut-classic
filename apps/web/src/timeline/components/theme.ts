import type { TrackType } from "@/timeline";

export const TIMELINE_AUDIO_WAVEFORM_COLOR = "rgba(255, 255, 255, 0.7)";

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		elementClassName: string;
		waveformColor?: string;
	}
> = {
	video: { elementClassName: "transparent" },
	text: { elementClassName: "bg-[#5DBAA0]" },
	audio: {
		elementClassName: "bg-[#8F5DBA]",
		waveformColor: TIMELINE_AUDIO_WAVEFORM_COLOR,
	},
	graphic: { elementClassName: "bg-[#BA5D7A]" },
	effect: { elementClassName: "bg-[#5d93ba]" },
} as const;

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/50";
export const DEFAULT_TIMELINE_BOOKMARK_COLOR = "#009dff";

/**
 * Export-range highlight. Kept to the accent token so the band reads as a
 * selection rather than as new content, and deliberately low-opacity: at full
 * strength it would hide the clips underneath, which is the one thing the user
 * needs to see while choosing what to export.
 */
export const TIME_RANGE_THEME = {
	fillClassName: "bg-primary/15 absolute inset-0",
	edgeClassName: "bg-primary/70 absolute top-0 h-full w-0.5",
	labelClassName:
		"bg-primary text-primary-foreground absolute top-0 rounded-b px-1 text-[10px] leading-4 tabular-nums whitespace-nowrap",
} as const;

export function getTimelineElementClassName({
	type,
}: {
	type: TrackType;
}): string {
	return TIMELINE_TRACK_THEME[type].elementClassName.trim();
}
