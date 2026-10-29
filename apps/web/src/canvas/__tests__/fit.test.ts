import { describe, expect, test } from "bun:test";
import { getFitScale, getVideoFit } from "../fit";

describe("getFitScale", () => {
	const canvas = { canvasWidth: 1920, canvasHeight: 804 };

	test("defaults to contain", () => {
		const args = { ...canvas, sourceWidth: 1920, sourceHeight: 1080 };
		expect(getFitScale(args)).toBeCloseTo(804 / 1080, 10);
		expect(getFitScale({ ...args, fit: "contain" })).toBe(getFitScale(args));
	});

	test("cover fills the canvas on both axes", () => {
		// 16:9 footage on a 2.39:1 canvas: width is the binding side
		const scale = getFitScale({
			...canvas,
			sourceWidth: 1920,
			sourceHeight: 1080,
			fit: "cover",
		});
		expect(scale).toBe(1);
		expect(1080 * scale).toBeGreaterThanOrEqual(804);
	});

	test("cover binds on height for footage wider than the canvas", () => {
		// 4:1 footage on 2.39:1: height is the binding side
		const scale = getFitScale({
			...canvas,
			sourceWidth: 4000,
			sourceHeight: 1000,
			fit: "cover",
		});
		expect(scale).toBeCloseTo(804 / 1000, 10);
		expect(4000 * scale).toBeGreaterThanOrEqual(1920);
	});

	test("same ratio: contain and cover agree", () => {
		const args = { canvasWidth: 1920, canvasHeight: 1080, sourceWidth: 3840, sourceHeight: 2160 };
		expect(getFitScale({ ...args, fit: "cover" })).toBeCloseTo(
			getFitScale({ ...args, fit: "contain" }),
			10,
		);
	});
});

describe("getVideoFit", () => {
	test("covers only when the canvas is locked", () => {
		expect(getVideoFit({ settings: undefined })).toBe("contain");
		expect(getVideoFit({ settings: {} })).toBe("contain");
		expect(getVideoFit({ settings: { saturnCanvasLock: null } })).toBe("contain");
		expect(getVideoFit({ settings: { saturnCanvasLock: { ratio: "2.39:1" } } })).toBe("cover");
	});
});
