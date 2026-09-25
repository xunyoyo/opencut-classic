import { describe, expect, test } from "bun:test";
import { getAudioOutputLength, getRangeOffsetSamples } from "../audio-range";
import {
	getSourceTimeAtClipTime,
	getClipTimeAtSourceTime,
} from "@/retime/resolve";

const TICKS_PER_SECOND = 120_000;
const SAMPLE_RATE = 44_100;

describe("getRangeOffsetSamples", () => {
	test("is zero when the range starts at the timeline origin", () => {
		expect(
			getRangeOffsetSamples({ rangeStartTicks: 0, sampleRate: SAMPLE_RATE }),
		).toBe(0);
	});

	test("converts a range start to whole samples", () => {
		expect(
			getRangeOffsetSamples({
				rangeStartTicks: 2 * TICKS_PER_SECOND,
				sampleRate: SAMPLE_RATE,
			}),
		).toBe(2 * SAMPLE_RATE);
	});

	test("floors a sub-sample range start", () => {
		// Half a sample past 1s. Flooring keeps the offset a whole sample index.
		const halfSampleTicks = TICKS_PER_SECOND / (SAMPLE_RATE * 2);
		expect(
			getRangeOffsetSamples({
				rangeStartTicks: TICKS_PER_SECOND + halfSampleTicks,
				sampleRate: SAMPLE_RATE,
			}),
		).toBe(SAMPLE_RATE);
	});
});

describe("getAudioOutputLength", () => {
	test("whole-second durations are exact", () => {
		expect(
			getAudioOutputLength({
				durationTicks: 3 * TICKS_PER_SECOND,
				sampleRate: SAMPLE_RATE,
			}),
		).toBe(3 * SAMPLE_RATE);
	});

	test("a range's length drives the buffer, not the full duration", () => {
		// The range 2s→5s must produce 3s of audio. Using the timeline duration
		// here would emit trailing silence.
		const fullDuration = 10 * TICKS_PER_SECOND;
		const rangeStartTicks = 2 * TICKS_PER_SECOND;
		const rangeEndTicks = 5 * TICKS_PER_SECOND;

		expect(
			getAudioOutputLength({
				durationTicks: rangeEndTicks - rangeStartTicks,
				sampleRate: SAMPLE_RATE,
			}),
		).toBe(3 * SAMPLE_RATE);

		expect(
			getAudioOutputLength({
				durationTicks: fullDuration,
				sampleRate: SAMPLE_RATE,
			}),
		).toBe(10 * SAMPLE_RATE);
	});

	test("no range reproduces ceil(duration_seconds * sampleRate)", () => {
		// Regression guard: the pre-range implementation was
		// `Math.ceil(duration / TICKS_PER_SECOND * sampleRate)`.
		const durationTicks = 3.5 * TICKS_PER_SECOND;
		expect(
			getAudioOutputLength({ durationTicks, sampleRate: SAMPLE_RATE }),
		).toBe(Math.ceil((durationTicks / TICKS_PER_SECOND) * SAMPLE_RATE));
	});
});

describe("range offset preserves the retimed read cursor", () => {
	/**
	 * Mirrors the read/write pair in `mixAudioChannels`. The invariant under
	 * test is that applying a range offset moves only the *write* index
	 * (`outputStartSample`) and leaves the sample index read from the source
	 * buffer (`sourceTime`) untouched.
	 *
	 * Rebasing `clipTime` instead would change `sourceTime` along the
	 * resampled axis, which is how a pitch-preserved clip drifts out of sync
	 * with the picture after a range export.
	 */
	function simulateMix({
		clipStartTimeSeconds,
		clipDurationSeconds,
		trimStart,
		retimeRate,
		rangeStartTicks,
		sampleCount,
	}: {
		clipStartTimeSeconds: number;
		clipDurationSeconds: number;
		trimStart: number;
		retimeRate?: number;
		rangeStartTicks: number;
		sampleCount: number;
	}): {
		writeIndices: number[];
		readSourceTimes: number[];
	} {
		const retime = { rate: retimeRate ?? 1, maintainPitch: true };
		const rangeOffsetSamples = getRangeOffsetSamples({
			rangeStartTicks,
			sampleRate: SAMPLE_RATE,
		});

		const outputStartSample =
			Math.floor(clipStartTimeSeconds * SAMPLE_RATE) - rangeOffsetSamples;
		const renderedLength = Math.ceil(clipDurationSeconds * SAMPLE_RATE);

		const writeIndices: number[] = [];
		const readSourceTimes: number[] = [];

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex < 0) continue;
			if (outputIndex >= sampleCount) break;

			// Unchanged from the implementation: absolute clip clock.
			const clipTime = i / SAMPLE_RATE;
			const sourceTime =
				trimStart +
				getSourceTimeAtClipTime({
					clipTime,
					retime,
				});

			writeIndices.push(outputIndex);
			readSourceTimes.push(sourceTime);
		}

		return { writeIndices, readSourceTimes };
	}

	test("a retimed clip's read positions are identical with and without a range", () => {
		// Same clip, exported whole vs. exported from 2s in. The samples read
		// must be the same list — only where they land in the output changes.
		const base = {
			clipStartTimeSeconds: 2,
			clipDurationSeconds: 1,
			trimStart: 0.5,
			retimeRate: 2,
			sampleCount: 10 * SAMPLE_RATE,
		};

		const withoutRange = simulateMix({ ...base, rangeStartTicks: 0 });
		const withRange = simulateMix({
			...base,
			rangeStartTicks: 2 * TICKS_PER_SECOND,
		});

		expect(withRange.readSourceTimes).toEqual(withoutRange.readSourceTimes);
	});

	test("a clip starting exactly at the range start begins at output sample 0", () => {
		const { writeIndices, readSourceTimes } = simulateMix({
			clipStartTimeSeconds: 2,
			clipDurationSeconds: 1,
			trimStart: 0,
			retimeRate: 2,
			rangeStartTicks: 2 * TICKS_PER_SECOND,
			sampleCount: 3 * SAMPLE_RATE,
		});

		expect(writeIndices[0]).toBe(0);
		// Read cursor starts at the clip's trim start, not at zero.
		expect(readSourceTimes[0]).toBeCloseTo(0, 10);
	});

	test("a clip straddling the range start is trimmed, not shifted", () => {
		// Clip runs 1s→4s; range starts at 2s. The first second of the clip
		// falls before the range and must be dropped from the output, while the
		// clip's own read cursor still advances from its start.
		const { writeIndices, readSourceTimes } = simulateMix({
			clipStartTimeSeconds: 1,
			clipDurationSeconds: 3,
			trimStart: 0,
			retimeRate: 1,
			rangeStartTicks: 2 * TICKS_PER_SECOND,
			sampleCount: 10 * SAMPLE_RATE,
		});

		expect(writeIndices[0]).toBe(0);
		// 1s of the clip was skipped, so the first written sample reads from
		// 1s into the source.
		expect(readSourceTimes[0]).toBeCloseTo(1, 5);
		expect(writeIndices.length).toBe(2 * SAMPLE_RATE);
	});

	test("the read cursor equals rangeStart + output time for rate 1", () => {
		// For an un-retimed clip the cursor is simply clipStart + elapsed, so
		// after the shift it must still resolve to rangeStart at output zero.
		const clipStartTimeSeconds = 2;
		const rangeStartTicks = 2 * TICKS_PER_SECOND;
		const rangeOffsetSamples = getRangeOffsetSamples({
			rangeStartTicks,
			sampleRate: SAMPLE_RATE,
		});

		const outputStartSample =
			Math.floor(clipStartTimeSeconds * SAMPLE_RATE) - rangeOffsetSamples;
		expect(outputStartSample).toBe(0);

		// Sanity-check the retime helpers used above agree at rate 1.
		expect(getSourceTimeAtClipTime({ clipTime: 1, retime: { rate: 1 } })).toBe(
			1,
		);
		expect(
			getClipTimeAtSourceTime({ sourceTime: 1, retime: { rate: 1 } }),
		).toBe(1);
	});

	test("a retimed clip maps clip time to source time by the retime rate", () => {
		// Guards the premise of the whole module: the read position depends on
		// clip time (absolute), scaled by rate. A 2x clip reads twice as far
		// into its source.
		const retime = { rate: 2 };
		expect(getSourceTimeAtClipTime({ clipTime: 0, retime })).toBe(0);
		expect(getSourceTimeAtClipTime({ clipTime: 1, retime })).toBe(2);

		// Half-rate reads half as far.
		expect(
			getSourceTimeAtClipTime({ clipTime: 1, retime: { rate: 0.5 } }),
		).toBe(0.5);
	});
});
