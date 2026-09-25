import { beforeEach, describe, expect, test } from "bun:test";
import { mediaTime, type MediaTime } from "@/wasm";
import { useTimeRangeStore } from "../store";

const TICKS_PER_SECOND = 120_000;

// Named for readability at the call sites; the constructor does the branding.
function ticks(value: number): MediaTime {
	return mediaTime({ ticks: value });
}

beforeEach(() => {
	useTimeRangeStore.getState().clearRange();
});

describe("time range store", () => {
	test("starts with no range", () => {
		expect(useTimeRangeStore.getState().range).toBeNull();
		expect(useTimeRangeStore.getState().hasRange()).toBe(false);
	});

	test("setRange stores the endpoints", () => {
		useTimeRangeStore.getState().setRange({
			start: ticks(TICKS_PER_SECOND),
			end: ticks(3 * TICKS_PER_SECOND),
		});

		const { range } = useTimeRangeStore.getState();
		expect(range?.start).toBe(ticks(TICKS_PER_SECOND));
		expect(range?.end).toBe(ticks(3 * TICKS_PER_SECOND));
		expect(useTimeRangeStore.getState().hasRange()).toBe(true);
	});

	test("clearRange removes the range", () => {
		useTimeRangeStore
			.getState()
			.setRange({ start: ticks(0), end: ticks(TICKS_PER_SECOND) });
		useTimeRangeStore.getState().clearRange();

		expect(useTimeRangeStore.getState().range).toBeNull();
		expect(useTimeRangeStore.getState().hasRange()).toBe(false);
	});

	test("hasRange is false for a zero-length range", () => {
		// A collapsed drag should read as "nothing selected", so the export
		// button does not offer an export that would encode zero frames.
		useTimeRangeStore
			.getState()
			.setRange({ start: ticks(500), end: ticks(500) });

		expect(useTimeRangeStore.getState().range).not.toBeNull();
		expect(useTimeRangeStore.getState().hasRange()).toBe(false);
	});

	test("later setRange calls replace the previous range", () => {
		useTimeRangeStore
			.getState()
			.setRange({ start: ticks(0), end: ticks(TICKS_PER_SECOND) });
		useTimeRangeStore.getState().setRange({
			start: ticks(4 * TICKS_PER_SECOND),
			end: ticks(6 * TICKS_PER_SECOND),
		});

		const { range } = useTimeRangeStore.getState();
		expect(range?.start).toBe(ticks(4 * TICKS_PER_SECOND));
		expect(range?.end).toBe(ticks(6 * TICKS_PER_SECOND));
	});
});
