import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type RefObject,
} from "react";
import { useEditor } from "@/editor/use-editor";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getBookmarkSnapPoints } from "@/timeline/bookmarks/snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import { normalizeDragRange, snapRangeToFrames } from "@/timeline/time-range";
import { useTimeRangeStore } from "@/timeline/time-range";
import { mediaTime, type MediaTime } from "@/wasm";

interface PendingRangeDrag {
	anchorTime: MediaTime;
	startMouseX: number;
	startMouseY: number;
}

interface UseTimeRangeDragProps {
	zoomLevel: number;
	scrollRef: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

/**
 * Shift-drag on the ruler creates an export range.
 *
 * Shift is the modifier rather than plain drag because the ruler's plain
 * gestures are already taken and deliberately so: a plain click seeks, and a
 * plain drag scrubs the playhead (`PlayheadController.onRulerMouseDown`). The
 * one behavioural cost is that Shift previously suppressed element-edge
 * snapping *during a scrub*, via `useShiftKey` in the playhead controller. That
 * rule is small and scrubbing still behaves exactly as before without it,
 * whereas taking over plain drag would remove scrubbing outright.
 *
 * Shift is not reused to mean "ignore snapping" inside this gesture (unlike the
 * bookmark drag) — it already means "create a range", and one key cannot mean
 * both. Frame quantisation still applies.
 */
export function useTimeRangeDrag({
	zoomLevel,
	scrollRef,
	snappingEnabled,
	onSnapPointChange,
}: UseTimeRangeDragProps) {
	const editor = useEditor();
	const setRange = useTimeRangeStore((state) => state.setRange);

	const [isDragging, setIsDragging] = useState(false);
	const [isPendingDrag, setIsPendingDrag] = useState(false);
	const pendingDragRef = useRef<PendingRangeDrag | null>(null);
	const anchorTimeRef = useRef<MediaTime | null>(null);
	const lastMouseXRef = useRef(0);

	/** Frame-quantises a client X coordinate into timeline time. */
	const getFrameTime = useCallback(
		({ clientX }: { clientX: number }): MediaTime | null => {
			const scrollContainer = scrollRef.current;
			if (!scrollContainer) return null;

			const activeProject = editor.project.getActive();
			if (!activeProject) return null;

			const duration = editor.timeline.getTotalDuration();
			const mouseTime = getMouseTimeFromClientX({
				clientX,
				containerRect: scrollContainer.getBoundingClientRect(),
				zoomLevel,
				scrollLeft: scrollContainer.scrollLeft,
			});

			// `snapRangeToFrames` is deliberately wasm-free, so it deals in plain
			// tick counts; the brand is reapplied here at the editor boundary.
			return mediaTime({
				ticks: snapRangeToFrames({
					range: { start: 0, end: mouseTime > duration ? duration : mouseTime },
					fps: activeProject.settings.fps,
				}).end,
			});
		},
		[editor, scrollRef, zoomLevel],
	);

	/** Frame-quantises, then optionally nudges onto a nearby element edge. */
	const resolveCursorTime = useCallback(
		({ clientX }: { clientX: number }): MediaTime | null => {
			const frameTime = getFrameTime({ clientX });
			if (frameTime === null) return null;
			if (!snappingEnabled) return frameTime;

			const activeScene = editor.scenes.getActiveScene();
			const { tracks } = activeScene;
			const snapPoints = buildTimelineSnapPoints({
				sources: [
					() => getElementEdgeSnapPoints({ tracks }),
					() =>
						getPlayheadSnapPoints({
							playheadTime: editor.playback.getCurrentTime(),
						}),
					() =>
						getBookmarkSnapPoints({ bookmarks: activeScene.bookmarks ?? [] }),
					() => getAnimationKeyframeSnapPointsForTimeline({ tracks }),
				],
			});
			const result = resolveTimelineSnap({
				targetTime: frameTime,
				snapPoints,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});

			return result.snapPoint ? result.snappedTime : frameTime;
		},
		[editor, getFrameTime, snappingEnabled, zoomLevel],
	);

	useEffect(() => {
		if (!isPendingDrag && !isDragging) return;

		const handleMouseMove = (event: MouseEvent) => {
			lastMouseXRef.current = event.clientX;

			if (isPendingDrag && pendingDragRef.current) {
				const { startMouseX, startMouseY } = pendingDragRef.current;
				const deltaX = Math.abs(event.clientX - startMouseX);
				const deltaY = Math.abs(event.clientY - startMouseY);

				// Below the threshold this is still a click, not a drag — a
				// Shift+click on the ruler should seek, exactly as it did before
				// this gesture existed.
				if (
					deltaX <= TIMELINE_DRAG_THRESHOLD_PX &&
					deltaY <= TIMELINE_DRAG_THRESHOLD_PX
				) {
					return;
				}

				// Promote the pending gesture to a real drag, keeping the
				// press-down time as the anchor so the range edge the user
				// pressed on does not drift.
				pendingDragRef.current = null;
				setIsPendingDrag(false);
				setIsDragging(true);
			}

			const anchor = anchorTimeRef.current;
			if (anchor === null) return;

			const cursorTime = resolveCursorTime({ clientX: event.clientX });
			if (cursorTime === null) return;

			const range = normalizeDragRange({ anchor, cursor: cursorTime });
			setRange({
				start: mediaTime({ ticks: range.start }),
				end: mediaTime({ ticks: range.end }),
			});
		};

		document.addEventListener("mousemove", handleMouseMove);
		return () => document.removeEventListener("mousemove", handleMouseMove);
	}, [isPendingDrag, isDragging, resolveCursorTime, setRange]);

	useEffect(() => {
		if (!isPendingDrag && !isDragging) return;

		const handleMouseUp = () => {
			pendingDragRef.current = null;
			anchorTimeRef.current = null;
			setIsPendingDrag(false);
			setIsDragging(false);
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [isPendingDrag, isDragging, onSnapPointChange]);

	/**
	 * Returns true when the gesture was claimed for range selection, so the
	 * caller can skip the playhead and seek handlers for this mousedown.
	 */
	const handleTimeRangeMouseDown = useCallback(
		({ event }: { event: React.MouseEvent }): boolean => {
			if (!event.shiftKey) return false;
			if (event.button !== 0) return false;

			const anchorTime = getFrameTime({ clientX: event.clientX });
			if (anchorTime === null) return false;

			event.preventDefault();
			event.stopPropagation();

			anchorTimeRef.current = anchorTime;
			pendingDragRef.current = {
				anchorTime,
				startMouseX: event.clientX,
				startMouseY: event.clientY,
			};
			lastMouseXRef.current = event.clientX;
			setIsPendingDrag(true);

			return true;
		},
		[getFrameTime],
	);

	return {
		isDraggingTimeRange: isDragging,
		handleTimeRangeMouseDown,
		lastMouseXRef,
	};
}
