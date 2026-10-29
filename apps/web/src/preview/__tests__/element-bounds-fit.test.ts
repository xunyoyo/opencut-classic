import { describe, expect, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { SceneTracks } from "@/timeline";
import { getVisibleElementsWithBounds } from "../element-bounds";

function tracksWith(type: "video" | "image"): SceneTracks {
	return {
		main: {
			id: "main",
			type: "video",
			elements: [
				{
					id: "clip",
					type,
					name: "clip",
					mediaId: "m1",
					startTime: 0,
					duration: 1000,
					trimStart: 0,
					trimEnd: 0,
					params: {},
				},
			],
		},
		overlay: [],
		audio: [],
	} as unknown as SceneTracks;
}

const assets = [
	{ id: "m1", type: "video", width: 1920, height: 1080 },
] as unknown as MediaAsset[];
const canvasSize = { width: 1920, height: 804 };

function boundsOf({
	type,
	videoFit,
}: {
	type: "video" | "image";
	videoFit?: "contain" | "cover";
}) {
	const [entry] = getVisibleElementsWithBounds({
		tracks: tracksWith(type),
		currentTime: 0,
		canvasSize,
		mediaAssets: assets,
		videoFit,
	});
	return entry.bounds;
}

describe("getVisibleElementsWithBounds videoFit", () => {
	test("default is contain", () => {
		expect(boundsOf({ type: "video" }).height).toBeCloseTo(804, 6);
	});

	test("cover makes the video selection box match the cropped render", () => {
		const b = boundsOf({ type: "video", videoFit: "cover" });
		expect(b.width).toBeCloseTo(1920, 6);
		expect(b.height).toBeCloseTo(1080, 6);
		expect(b.cx).toBe(960);
		expect(b.cy).toBe(402);
	});

	test("images are not covered", () => {
		const b = boundsOf({ type: "image", videoFit: "cover" });
		expect(b.height).toBeCloseTo(804, 6);
	});
});
