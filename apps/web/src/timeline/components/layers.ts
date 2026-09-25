export const TIMELINE_LAYERS = {
	trackContent: 10,
	dragLine: 20,
	// Below the playhead so the selected span never hides where the playhead
	// currently is.
	timeRange: 25,
	playhead: 30,
	snapIndicator: 40,
} as const;
