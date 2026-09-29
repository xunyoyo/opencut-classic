const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * What one imported shot is assumed to keep resident once it is in the library.
 *
 * Not the video: after saving, the media manager swaps the downloaded file for
 * the disk-backed copy read back from OPFS, so the bytes leave the heap. What
 * stays is the thumbnail data URL (held in memory and in IndexedDB), the asset
 * record and the timeline element built for it. Well under a megabyte in
 * practice; a full megabyte leaves room for a browser that turns out to keep
 * more of the file than expected.
 */
export const ESTIMATED_BYTES_PER_SHOT = 1 * MIB;

/**
 * Held regardless of shot count: the downloads in flight (see
 * DOWNLOAD_CONCURRENCY in media-import.ts), each a whole video plus its decode
 * buffers, with the long tail of renders at tens of megabytes.
 */
export const IN_FLIGHT_BYTES = 3 * 60 * MIB;

/**
 * Budget used when the browser exposes neither signal (Safari, Firefox).
 *
 * Roughly what a single tab can hold before it is killed on a typical laptop.
 */
export const FALLBACK_MEMORY_BUDGET_BYTES = 2 * GIB;

/**
 * Share of the device's memory one tab is assumed to be able to use.
 *
 * `navigator.deviceMemory` is the whole machine, rounded down and capped at 8,
 * and the OS, the browser and every other tab share it.
 */
const DEVICE_MEMORY_TAB_SHARE = 0.5;

/** Memory hints read from the browser; each is absent where unsupported. */
export interface MemorySignals {
	/** `navigator.deviceMemory`, in GiB. */
	deviceMemoryGiB?: number;
	/** Chrome's `performance.memory.jsHeapSizeLimit`, in bytes. */
	jsHeapSizeLimit?: number;
	/** Chrome's `performance.memory.usedJSHeapSize`, in bytes. */
	usedJSHeapSize?: number;
}

export interface ImportMemoryEstimate {
	estimatedBytes: number;
	budgetBytes: number;
	exceedsBudget: boolean;
	/** How many shots fit in the budget; never below 1. */
	suggestedBatchSize: number;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/**
 * Reads the memory hints the browser offers. Neither API is in the DOM typings
 * (`performance.memory` is Chrome-only, `deviceMemory` is Chromium-only), so
 * both are read through `unknown` and validated.
 */
export function readMemorySignals({
	nav = globalThis.navigator,
	perf = globalThis.performance,
}: {
	nav?: unknown;
	perf?: unknown;
} = {}): MemorySignals {
	const deviceMemory =
		typeof nav === "object" && nav !== null
			? (nav as { deviceMemory?: unknown }).deviceMemory
			: undefined;
	const memory =
		typeof perf === "object" && perf !== null
			? (perf as { memory?: unknown }).memory
			: undefined;
	const heap =
		typeof memory === "object" && memory !== null
			? (memory as { jsHeapSizeLimit?: unknown; usedJSHeapSize?: unknown })
			: undefined;

	return {
		deviceMemoryGiB: positiveNumber(deviceMemory),
		jsHeapSizeLimit: positiveNumber(heap?.jsHeapSizeLimit),
		usedJSHeapSize: positiveNumber(heap?.usedJSHeapSize),
	};
}

/**
 * Rough check of whether importing `shotCount` shots fits in the tab's memory.
 *
 * The budget is the tightest of the signals that are present, falling back to
 * a fixed figure when there are none. Only advisory: the caller warns and
 * still imports.
 */
export function estimateImportMemory({
	shotCount,
	signals,
	bytesPerShot = ESTIMATED_BYTES_PER_SHOT,
}: {
	shotCount: number;
	signals: MemorySignals;
	bytesPerShot?: number;
}): ImportMemoryEstimate {
	const budgets: number[] = [];
	if (signals.deviceMemoryGiB !== undefined) {
		budgets.push(signals.deviceMemoryGiB * GIB * DEVICE_MEMORY_TAB_SHARE);
	}
	if (signals.jsHeapSizeLimit !== undefined) {
		budgets.push(
			Math.max(0, signals.jsHeapSizeLimit - (signals.usedJSHeapSize ?? 0)),
		);
	}

	const budgetBytes =
		budgets.length > 0 ? Math.min(...budgets) : FALLBACK_MEMORY_BUDGET_BYTES;
	const estimatedBytes =
		shotCount > 0 ? IN_FLIGHT_BYTES + shotCount * bytesPerShot : 0;

	return {
		estimatedBytes,
		budgetBytes,
		exceedsBudget: estimatedBytes > budgetBytes,
		suggestedBatchSize: Math.max(
			1,
			Math.floor((budgetBytes - IN_FLIGHT_BYTES) / bytesPerShot),
		),
	};
}

/** `1.5 GB` style label for the toast. */
export function formatGigabytes({ bytes }: { bytes: number }): string {
	return `${(bytes / GIB).toFixed(1)} GB`;
}
