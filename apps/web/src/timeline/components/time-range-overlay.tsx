"use client";

import { useEditor } from "@/editor/use-editor";
import { useContainerSize } from "@/hooks/use-container-size";
import { timelineTimeToSnappedPixels } from "@/timeline";
import { useScrollPosition } from "@/timeline/hooks/use-scroll-position";
import { formatTimecode } from "opencut-wasm";
import { DEFAULT_FPS } from "@/fps/defaults";
import { useExportRange } from "@/timeline/time-range";
import type { TimeRange } from "@/timeline/time-range";
import {
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
} from "./layout";
import { TIMELINE_LAYERS } from "./layers";
import { TIME_RANGE_THEME } from "./theme";

interface TimeRangeOverlayProps {
	zoomLevel: number;
	timelineRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	hasHorizontalScrollbar: boolean;
}

/**
 * Semi-transparent highlight for the export range.
 *
 * Rendered as a sibling of the ruler's scroll container (the same placement
 * `TimelinePlayhead` uses) so the band can span the ruler, the bookmark row and
 * the track rows at once. Confining it to the ruler would make the selection
 * read as a ruler adornment rather than as the stretch of timeline about to be
 * exported.
 */
export function TimeRangeOverlay({
	zoomLevel,
	timelineRef,
	tracksScrollRef,
	hasHorizontalScrollbar,
}: TimeRangeOverlayProps) {
	const range = useExportRange();
	const editor = useEditor();
	const { scrollLeft } = useScrollPosition({ scrollRef: tracksScrollRef });
	const { height: timelineHeight } = useContainerSize({
		containerRef: timelineRef,
	});

	if (!range) return null;

	const fps = editor.project.getActiveOrNull()?.settings.fps ?? DEFAULT_FPS;

	const startPixels = timelineTimeToSnappedPixels({
		time: range.start,
		zoomLevel,
	});
	const endPixels = timelineTimeToSnappedPixels({ time: range.end, zoomLevel });
	const width = Math.max(1, endPixels - startPixels);
	const left = TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX + startPixels - scrollLeft;

	const totalHeight = Math.max(
		0,
		(timelineHeight || 400) -
			(hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX - 5 : 0),
	);

	return (
		<div
			className="pointer-events-none absolute"
			style={{
				left: `${left}px`,
				top: 0,
				width: `${width}px`,
				height: `${totalHeight}px`,
				zIndex: TIMELINE_LAYERS.timeRange,
			}}
		>
			<div className={TIME_RANGE_THEME.fillClassName} />

			{/* Edge markers: without a visible boundary the user cannot tell how
			    far the selection runs, which is worst at low zoom where a few
			    seconds collapse to a few pixels. */}
			<div className={TIME_RANGE_THEME.edgeClassName} style={{ left: 0 }} />
			<div className={TIME_RANGE_THEME.edgeClassName} style={{ right: 0 }} />

			<RangeLabel range={range} fps={fps} />
		</div>
	);
}

function RangeLabel({
	range,
	fps,
}: {
	range: TimeRange;
	fps: { numerator: number; denominator: number };
}) {
	// Frame-level precision, matching the preview toolbar's timecode: a range
	// boundary that is only accurate to the second would misrepresent what gets
	// exported.
	return (
		<>
			<span className={TIME_RANGE_THEME.labelClassName} style={{ left: 0 }}>
				{formatTimecode({
					time: range.start,
					format: "HH:MM:SS:FF",
					rate: fps,
				})}
			</span>
			<span className={TIME_RANGE_THEME.labelClassName} style={{ right: 0 }}>
				{formatTimecode({
					time: range.end,
					format: "HH:MM:SS:FF",
					rate: fps,
				})}
			</span>
		</>
	);
}
