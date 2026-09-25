import type { MediaTime } from "@/wasm";

/**
 * A span of the timeline `[start, end)`, in integer ticks.
 *
 * Fields are branded `MediaTime` at the boundaries where the editor hands
 * values in, but the helper functions in `./utils` treat them as plain tick
 * counts — that is what keeps them loadable under `bun test`, which cannot
 * import a *value* from `@/wasm` (see the note in `utils.ts`).
 *
 * This is deliberately *not* part of `SelectionManager`: that manager answers
 * "which elements / keyframes / mask points are selected", and an action like
 * "delete selection" has a single obvious meaning there. A time span has no
 * element identity, so merging the two would make "delete selection" ambiguous
 * the moment a range exists.
 */
export interface TimeRange {
	start: MediaTime;
	end: MediaTime;
}

/** A span in bare tick counts, for the wasm-free helpers. */
export interface TickSpan {
	start: number;
	end: number;
}
