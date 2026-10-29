import { describe, expect, test } from "bun:test";
import { computeVisualTransform } from "../compositor/frame-descriptor";

const renderer = { width: 1920, height: 804 };
const identity = {
	transform: {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	},
};

describe("computeVisualTransform fit", () => {
	test("contain (default) keeps the whole 16:9 frame inside a 2.39:1 canvas", () => {
		const t = computeVisualTransform({
			renderer,
			resolved: identity,
			sourceWidth: 1920,
			sourceHeight: 1080,
		});
		expect(t.height).toBeCloseTo(804, 6);
		expect(t.width).toBeCloseTo((1920 * 804) / 1080, 6);
	});

	test("cover fills the canvas width and crops the height", () => {
		const t = computeVisualTransform({
			renderer,
			resolved: identity,
			sourceWidth: 1920,
			sourceHeight: 1080,
			fit: "cover",
		});
		expect(t.width).toBeCloseTo(1920, 6);
		expect(t.height).toBeCloseTo(1080, 6);
		expect(t.centerX).toBe(960);
		expect(t.centerY).toBe(402);
	});

	test("user scale multiplies on top of cover; negative scale flips", () => {
		const t = computeVisualTransform({
			renderer,
			resolved: {
				transform: { ...identity.transform, scaleX: -1.5, scaleY: 2 },
			},
			sourceWidth: 1920,
			sourceHeight: 1080,
			fit: "cover",
		});
		expect(t.width).toBeCloseTo(1920 * 1.5, 6);
		expect(t.height).toBeCloseTo(1080 * 2, 6);
		expect(t.flipX).toBe(true);
		expect(t.flipY).toBe(false);
	});
});
