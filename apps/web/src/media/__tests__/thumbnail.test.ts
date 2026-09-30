import { describe, expect, test } from "bun:test";
import { thumbnailSize } from "../thumbnail";

describe("thumbnailSize", () => {
	test("keeps a source that already fits", () => {
		expect(thumbnailSize({ width: 200, height: 100 })).toEqual({
			width: 200,
			height: 100,
		});
	});

	test("caps the longest edge at 320 in either orientation", () => {
		expect(thumbnailSize({ width: 1920, height: 1080 })).toEqual({
			width: 320,
			height: 180,
		});
		expect(thumbnailSize({ width: 1080, height: 1920 })).toEqual({
			width: 180,
			height: 320,
		});
	});

	test("never rounds the short edge of a very wide source down to 0", () => {
		expect(thumbnailSize({ width: 100_000, height: 1 })).toEqual({
			width: 320,
			height: 1,
		});
	});

	test("never rounds the short edge of a very tall source down to 0", () => {
		expect(thumbnailSize({ width: 1, height: 100_000 })).toEqual({
			width: 1,
			height: 320,
		});
	});

	test("never returns a 0 edge for a degenerate source", () => {
		expect(thumbnailSize({ width: 0, height: 0 })).toEqual({
			width: 1,
			height: 1,
		});
		expect(thumbnailSize({ width: 0, height: 4000 })).toEqual({
			width: 1,
			height: 320,
		});
	});
});
