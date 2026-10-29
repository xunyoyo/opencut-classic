import { DEFAULT_CANVAS_PRESETS } from "@/canvas/sizes";
import type { TCanvasSize, TProjectSettings } from "@/project/types";

/**
 * AI-Saturn lets a project use a free-form aspect ratio ("2.39:1") instead of
 * one of its six presets, and passes it to the editor as `?ratio=`. The
 * format and range rules are shared with the platform's other front ends:
 *
 *   - `W:H`, W and H positive, at most two significant decimals
 *   - full-width colon and surrounding whitespace tolerated
 *   - normalised: half-width colon, no spaces, trailing zeros dropped,
 *     not reduced (`10:8` stays `10:8`)
 *   - 1/3 <= W/H <= 3, and at most 16 characters once normalised
 */

/** Long side of a canvas derived from a ratio. */
export const CUSTOM_RATIO_LONG_SIDE = 1920;

const MAX_RATIO_LENGTH = 16;
const MAX_RAW_LENGTH = 64;
const RATIO_PATTERN = /^(\d+)(?:\.(\d+))?:(\d+)(?:\.(\d+))?$/;

export interface ParsedCustomRatio {
	/** Normalised form, what gets stored and compared. */
	ratio: string;
	/** Width divided by height. */
	value: number;
}

function normalizeNumber({
	whole,
	fraction,
}: {
	whole: string;
	fraction: string | undefined;
}): string {
	const wholePart = whole.replace(/^0+(?=\d)/, "");
	const fractionPart = (fraction ?? "").replace(/0+$/, "");
	return fractionPart ? `${wholePart}.${fractionPart}` : wholePart;
}

/** Hundredths as an integer, so the range test is exact. */
function toHundredths({
	whole,
	fraction,
}: {
	whole: string;
	fraction: string | undefined;
}): number {
	return Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));
}

export function parseCustomRatio(
	raw: string | null | undefined,
): ParsedCustomRatio | null {
	if (typeof raw !== "string" || raw.length > MAX_RAW_LENGTH) return null;

	const compact = raw.replace(/：/g, ":").replace(/\s+/g, "");
	const match = RATIO_PATTERN.exec(compact);
	if (!match) return null;

	const [, wholeW, rawFractionW, wholeH, rawFractionH] = match;
	// Trailing zeros are noise ("2.390:1.0"), so they do not count against the
	// two-decimal limit; any other third decimal does.
	const fractionW = rawFractionW?.replace(/0+$/, "");
	const fractionH = rawFractionH?.replace(/0+$/, "");
	if ((fractionW?.length ?? 0) > 2 || (fractionH?.length ?? 0) > 2) return null;
	const ratio = `${normalizeNumber({ whole: wholeW, fraction: fractionW })}:${normalizeNumber({ whole: wholeH, fraction: fractionH })}`;
	if (ratio.length > MAX_RATIO_LENGTH) return null;

	const width = toHundredths({ whole: wholeW, fraction: fractionW });
	const height = toHundredths({ whole: wholeH, fraction: fractionH });
	if (width <= 0 || height <= 0) return null;
	if (width > height * 3 || height > width * 3) return null;

	return { ratio, value: width / height };
}

function roundToEven(value: number): number {
	return 2 * Math.round(value / 2);
}

/**
 * Canvas for a ratio: long side 1920, short side the nearest even number
 * (even because the encoders want it). 16:9 -> 1920x1080, 9:16 -> 1080x1920,
 * 2.39:1 -> 1920x804, 1:1 -> 1920x1920.
 */
export function canvasSizeForRatio({ value }: { value: number }): TCanvasSize {
	if (value >= 1) {
		return {
			width: CUSTOM_RATIO_LONG_SIDE,
			height: roundToEven(CUSTOM_RATIO_LONG_SIDE / value),
		};
	}
	return {
		width: roundToEven(CUSTOM_RATIO_LONG_SIDE * value),
		height: CUSTOM_RATIO_LONG_SIDE,
	};
}

/** Two canvases count as the same ratio within half a percent. */
export function isCanvasOfRatio({
	canvasSize,
	value,
}: {
	canvasSize: TCanvasSize;
	value: number;
}): boolean {
	if (canvasSize.width <= 0 || canvasSize.height <= 0) return false;
	const actual = canvasSize.width / canvasSize.height;
	return Math.abs(actual / value - 1) <= 0.005;
}

function isPresetSize(canvasSize: TCanvasSize): boolean {
	return DEFAULT_CANVAS_PRESETS.some(
		(preset) =>
			preset.width === canvasSize.width && preset.height === canvasSize.height,
	);
}

/**
 * The settings a custom ratio imposes: the canvas, the mode that matches it (a
 * size that happens to equal a preset is shown as that preset), the lock, and
 * the record of what the platform sent.
 */
export function settingsForRatio({
	parsed,
}: {
	parsed: ParsedCustomRatio;
}): Partial<TProjectSettings> {
	return {
		...canvasSettingsForRatio({ parsed }),
		saturnCanvasLock: { ratio: parsed.ratio },
		saturnPlatformRatio: parsed.ratio,
	};
}

function canvasSettingsForRatio({
	parsed,
}: {
	parsed: ParsedCustomRatio;
}): Partial<TProjectSettings> {
	const canvasSize = canvasSizeForRatio({ value: parsed.value });
	const isPreset = isPresetSize(canvasSize);
	return {
		canvasSize,
		canvasSizeMode: isPreset ? "preset" : "custom",
		...(isPreset ? {} : { lastCustomCanvasSize: canvasSize }),
	};
}

/**
 * What to do to an existing draft when AI-Saturn reopens it with a ratio.
 * `custom` says whether the platform marked the ratio as the project's own
 * custom one (`ratioCustom=1`) or one of its presets.
 *
 * No (valid) ratio: nothing; an existing lock is kept.
 *
 * Custom ratio:
 *   - The draft's unlocked canvas and the platform's last-sent ratio is this
 *     same ratio: the user took the canvas back on purpose, so leave it.
 *   - Canvas already has that ratio: keep the size (the user may have raised
 *     the resolution) and only add the lock and the record.
 *   - Otherwise (first time, or the platform's ratio changed): re-impose the
 *     canvas and lock it.
 *
 * Preset ratio:
 *   - Draft carries the platform lock: release it and set the preset's canvas
 *     (the project was switched back from custom).
 *   - No lock: nothing, so old drafts and drafts the user unlocked behave as
 *     they always did. The only write is refreshing a stale record, so that a
 *     later return to the *same* custom ratio is seen as a change.
 *
 * Returns the settings patch, or null when there is nothing to change.
 */
export function planDraftRatioUpdate({
	settings,
	parsed,
	custom,
}: {
	settings: Pick<
		TProjectSettings,
		"canvasSize" | "saturnCanvasLock" | "saturnPlatformRatio"
	>;
	parsed: ParsedCustomRatio | null;
	custom: boolean;
}): Partial<TProjectSettings> | null {
	if (!parsed) return null;

	const locked = Boolean(settings.saturnCanvasLock);
	const sameAsLastSent = settings.saturnPlatformRatio === parsed.ratio;
	const canvasMatches = isCanvasOfRatio({
		canvasSize: settings.canvasSize,
		value: parsed.value,
	});

	if (!custom) {
		if (locked) {
			return {
				...(canvasMatches ? {} : canvasSettingsForRatio({ parsed })),
				saturnCanvasLock: null,
				saturnPlatformRatio: parsed.ratio,
			};
		}
		if (settings.saturnPlatformRatio && !sameAsLastSent) {
			return { saturnPlatformRatio: parsed.ratio };
		}
		return null;
	}

	if (!locked && sameAsLastSent) return null;

	if (canvasMatches) {
		if (locked && sameAsLastSent && settings.saturnCanvasLock?.ratio === parsed.ratio) {
			return null;
		}
		return {
			saturnCanvasLock: { ratio: parsed.ratio },
			saturnPlatformRatio: parsed.ratio,
		};
	}

	return settingsForRatio({ parsed });
}
