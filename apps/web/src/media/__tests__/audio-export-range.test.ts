import { describe, expect, test } from "bun:test";
import {
	getSilentDurationTicks,
	resolveAudioExportRange,
} from "../audio-export-range";

const TICKS_PER_SECOND = 120_000;

describe("resolveAudioExportRange", () => {
	test("returns no range and the full duration when no range is given", () => {
		const result = resolveAudioExportRange({
			range: undefined,
			totalDuration: 10 * TICKS_PER_SECOND,
		});

		expect(result.range).toBeUndefined();
		expect(result.durationTicks).toBe(10 * TICKS_PER_SECOND);
	});

	test("passes an in-bounds range straight through", () => {
		const result = resolveAudioExportRange({
			range: { start: TICKS_PER_SECOND, end: 3 * TICKS_PER_SECOND },
			totalDuration: 10 * TICKS_PER_SECOND,
		});

		expect(result.range).toEqual({
			startTicks: TICKS_PER_SECOND,
			endTicks: 3 * TICKS_PER_SECOND,
		});
		expect(result.durationTicks).toBe(2 * TICKS_PER_SECOND);
	});

	// A selection dragged past the last clip is the ordinary case, and the video
	// side clamps rather than failing. The audio file has to match that span or
	// the two artifacts disagree about how long the project is.
	test("clamps an end past the timeline rather than rejecting it", () => {
		const result = resolveAudioExportRange({
			range: { start: 0, end: 999 * TICKS_PER_SECOND },
			totalDuration: 5 * TICKS_PER_SECOND,
		});

		expect(result.range).toEqual({
			startTicks: 0,
			endTicks: 5 * TICKS_PER_SECOND,
		});
		expect(result.durationTicks).toBe(5 * TICKS_PER_SECOND);
	});

	test("orders a reversed range instead of producing a negative span", () => {
		const result = resolveAudioExportRange({
			range: { start: 4 * TICKS_PER_SECOND, end: 2 * TICKS_PER_SECOND },
			totalDuration: 10 * TICKS_PER_SECOND,
		});

		expect(result.range).toEqual({
			startTicks: 2 * TICKS_PER_SECOND,
			endTicks: 4 * TICKS_PER_SECOND,
		});
		expect(result.durationTicks).toBe(2 * TICKS_PER_SECOND);
	});

	test("clamps a negative start to the timeline origin", () => {
		const result = resolveAudioExportRange({
			range: { start: -5 * TICKS_PER_SECOND, end: TICKS_PER_SECOND },
			totalDuration: 10 * TICKS_PER_SECOND,
		});

		expect(result.range).toEqual({
			startTicks: 0,
			endTicks: TICKS_PER_SECOND,
		});
		expect(result.durationTicks).toBe(TICKS_PER_SECOND);
	});

	test("reports a collapsed range as nothing to export", () => {
		const result = resolveAudioExportRange({
			range: { start: 2 * TICKS_PER_SECOND, end: 2 * TICKS_PER_SECOND },
			totalDuration: 10 * TICKS_PER_SECOND,
		});

		expect(result.range).toBeUndefined();
		expect(result.durationTicks).toBe(0);
	});

	test("reports a range entirely past the timeline as nothing to export", () => {
		const result = resolveAudioExportRange({
			range: { start: 20 * TICKS_PER_SECOND, end: 30 * TICKS_PER_SECOND },
			totalDuration: 5 * TICKS_PER_SECOND,
		});

		expect(result.range).toBeUndefined();
		expect(result.durationTicks).toBe(0);
	});

	test("treats a zero-length timeline as nothing to export", () => {
		const result = resolveAudioExportRange({
			range: undefined,
			totalDuration: 0,
		});

		expect(result.durationTicks).toBe(0);
	});
});

describe("getSilentDurationTicks", () => {
	test("keeps the requested duration when it is long enough", () => {
		expect(
			getSilentDurationTicks({ durationTicks: 5 * TICKS_PER_SECOND }),
		).toBe(5 * TICKS_PER_SECOND);
	});

	// A zero-frame AudioBuffer is not constructible, so an empty timeline needs
	// a floor rather than the literal zero it asked for.
	test("floors an empty timeline at the shortest representable length", () => {
		expect(getSilentDurationTicks({ durationTicks: 0 })).toBe(120);
	});
});
