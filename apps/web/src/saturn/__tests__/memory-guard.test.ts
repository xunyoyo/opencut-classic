import { describe, expect, it } from "bun:test";
import {
	ESTIMATED_BYTES_PER_SHOT,
	FALLBACK_MEMORY_BUDGET_BYTES,
	IN_FLIGHT_BYTES,
	estimateImportMemory,
	formatGigabytes,
	readMemorySignals,
} from "../memory-guard";

const GIB = 1024 * 1024 * 1024;

describe("readMemorySignals", () => {
	it("reads both Chrome signals", () => {
		expect(
			readMemorySignals({
				nav: { deviceMemory: 8 },
				perf: {
					memory: { jsHeapSizeLimit: 4 * GIB, usedJSHeapSize: GIB },
				},
			}),
		).toEqual({
			deviceMemoryGiB: 8,
			jsHeapSizeLimit: 4 * GIB,
			usedJSHeapSize: GIB,
		});
	});

	it("leaves out signals the browser does not expose", () => {
		expect(readMemorySignals({ nav: {}, perf: {} })).toEqual({
			deviceMemoryGiB: undefined,
			jsHeapSizeLimit: undefined,
			usedJSHeapSize: undefined,
		});
		expect(readMemorySignals({ nav: undefined, perf: null })).toEqual({
			deviceMemoryGiB: undefined,
			jsHeapSizeLimit: undefined,
			usedJSHeapSize: undefined,
		});
	});

	it("ignores values that are not positive finite numbers", () => {
		expect(
			readMemorySignals({
				nav: { deviceMemory: "8" },
				perf: { memory: { jsHeapSizeLimit: Number.NaN, usedJSHeapSize: -1 } },
			}),
		).toEqual({
			deviceMemoryGiB: undefined,
			jsHeapSizeLimit: undefined,
			usedJSHeapSize: undefined,
		});
	});
});

describe("estimateImportMemory", () => {
	it("scales the estimate with the shot count", () => {
		const result = estimateImportMemory({ shotCount: 10, signals: {} });
		expect(result.estimatedBytes).toBe(
			IN_FLIGHT_BYTES + 10 * ESTIMATED_BYTES_PER_SHOT,
		);
	});

	it("falls back to a fixed budget without any signal", () => {
		const result = estimateImportMemory({ shotCount: 10, signals: {} });
		expect(result.budgetBytes).toBe(FALLBACK_MEMORY_BUDGET_BYTES);
		expect(result.exceedsBudget).toBe(false);
	});

	it("does not flag the customer's 309-shot import on an 8 GB machine", () => {
		// The videos no longer stay on the heap once saved, so shot count alone
		// must not raise the alarm the way it did when every file was resident.
		const result = estimateImportMemory({
			shotCount: 309,
			signals: { deviceMemoryGiB: 8 },
		});
		expect(result.budgetBytes).toBe(4 * GIB);
		expect(result.exceedsBudget).toBe(false);
	});

	it("uses the free heap when it is tighter than device memory", () => {
		const result = estimateImportMemory({
			shotCount: 400,
			signals: {
				deviceMemoryGiB: 8,
				jsHeapSizeLimit: 2 * GIB,
				usedJSHeapSize: 1.5 * GIB,
			},
		});
		expect(result.budgetBytes).toBe(0.5 * GIB);
		expect(result.exceedsBudget).toBe(true);
		expect(result.suggestedBatchSize).toBe(
			Math.floor((0.5 * GIB - IN_FLIGHT_BYTES) / ESTIMATED_BYTES_PER_SHOT),
		);
	});

	it("never suggests a batch smaller than one shot", () => {
		const result = estimateImportMemory({
			shotCount: 3,
			signals: { jsHeapSizeLimit: GIB, usedJSHeapSize: 2 * GIB },
		});
		expect(result.budgetBytes).toBe(0);
		expect(result.suggestedBatchSize).toBe(1);
	});

	it("stays under budget for a small import", () => {
		const result = estimateImportMemory({
			shotCount: 20,
			signals: { deviceMemoryGiB: 4 },
		});
		expect(result.exceedsBudget).toBe(false);
	});
});

describe("formatGigabytes", () => {
	it("prints one decimal", () => {
		expect(formatGigabytes({ bytes: 1.5 * GIB })).toBe("1.5 GB");
		expect(formatGigabytes({ bytes: 6 * GIB })).toBe("6.0 GB");
	});
});
