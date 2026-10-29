import { describe, expect, test } from "bun:test";
import { resolveFirstMediaSettings } from "../first-media-settings";

const asset = { type: "video", width: 1280, height: 720, fps: 30 };

describe("resolveFirstMediaSettings", () => {
	test("unlocked project: canvas follows the first clip, original recorded", () => {
		const { canvas, fps } = resolveFirstMediaSettings({
			settings: { originalCanvasSize: null },
			asset,
		});
		expect(canvas).toEqual({
			canvasSize: { width: 1280, height: 720 },
			originalCanvasSize: { width: 1280, height: 720 },
		});
		expect(fps).not.toBeNull();
	});

	test("unlocked project with an original already: original is kept", () => {
		const { canvas } = resolveFirstMediaSettings({
			settings: { originalCanvasSize: { width: 1, height: 1 } },
			asset,
		});
		expect(canvas).toEqual({ canvasSize: { width: 1280, height: 720 } });
	});

	test("a null lock counts as unlocked", () => {
		const { canvas } = resolveFirstMediaSettings({
			settings: { originalCanvasSize: null, saturnCanvasLock: null },
			asset,
		});
		expect(canvas).not.toBeNull();
	});

	test("locked project: canvas and original are not touched, fps still follows", () => {
		const { canvas, fps } = resolveFirstMediaSettings({
			settings: {
				originalCanvasSize: null,
				saturnCanvasLock: { ratio: "2.39:1" },
			},
			asset,
		});
		expect(canvas).toBeNull();
		expect(fps).not.toBeNull();
	});

	test("no dimensions or no fps: nothing to apply", () => {
		const { canvas, fps } = resolveFirstMediaSettings({
			settings: null,
			asset: { type: "image" },
		});
		expect(canvas).toBeNull();
		expect(fps).toBeNull();
	});
});
