/**
 * Export range selection for the timeline.
 *
 * Session state, on purpose: this store is *not* wrapped in the `persist`
 * middleware that `timeline-store.ts` uses. A range is neither an editor
 * preference nor document content, and persisting it would resurrect it across
 * sessions — a user who framed a range, closed the tab, and came back days
 * later would silently export a clipped video with no visible cause.
 */

import { create } from "zustand";
import type { MediaTime } from "@/wasm";
import type { TimeRange } from "./types";
import { isUsableRange } from "./utils";

interface TimeRangeStore {
	range: TimeRange | null;
	setRange: ({ start, end }: { start: MediaTime; end: MediaTime }) => void;
	clearRange: () => void;
	hasRange: () => boolean;
}

export const useTimeRangeStore = create<TimeRangeStore>()((set, get) => ({
	range: null,

	setRange: ({ start, end }) => {
		set({ range: { start, end } });
	},

	clearRange: () => {
		set({ range: null });
	},

	// Derived query rather than a stored boolean, so the two can never disagree.
	hasRange: () => isUsableRange({ range: get().range }),
}));

/**
 * Reactive read for components. Returns `null` for a degenerate range (one that
 * a collapsed drag rounded down to zero length), so callers treat it the same
 * as "nothing selected".
 */
export function useExportRange(): TimeRange | null {
	return useTimeRangeStore((state) =>
		isUsableRange({ range: state.range }) ? state.range : null,
	);
}
