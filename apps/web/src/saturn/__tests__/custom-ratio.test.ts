import { describe, expect, test } from "bun:test";
import {
	canvasSizeForRatio,
	isCanvasOfRatio,
	parseCustomRatio,
	planDraftRatioUpdate,
	settingsForRatio,
} from "../custom-ratio";

function parsed(raw: string) {
	const result = parseCustomRatio(raw);
	if (!result) throw new Error(`expected ${raw} to parse`);
	return result;
}

describe("parseCustomRatio", () => {
	test("accepts and normalises valid ratios", () => {
		expect(parseCustomRatio("2.39:1")?.ratio).toBe("2.39:1");
		expect(parseCustomRatio("5:4")?.ratio).toBe("5:4");
		expect(parseCustomRatio("16:10")?.ratio).toBe("16:10");
		expect(parseCustomRatio("2.390:1.0")?.ratio).toBe("2.39:1");
		expect(parseCustomRatio("10:8")?.ratio).toBe("10:8");
		expect(parseCustomRatio("02.5:1")?.ratio).toBe("2.5:1");
	});

	test("tolerates full-width colon and whitespace", () => {
		expect(parseCustomRatio(" 2.39：1 ")?.ratio).toBe("2.39:1");
		expect(parseCustomRatio("16 : 9")?.ratio).toBe("16:9");
	});

	test("computes the numeric value", () => {
		expect(parsed("16:9").value).toBeCloseTo(16 / 9, 10);
		expect(parsed("2.39:1").value).toBeCloseTo(2.39, 10);
	});

	test("range is inclusive at 1/3 and 3", () => {
		expect(parseCustomRatio("3:1")).not.toBeNull();
		expect(parseCustomRatio("1:3")).not.toBeNull();
		expect(parseCustomRatio("2.4:0.8")).not.toBeNull();
		expect(parseCustomRatio("3.01:1")).toBeNull();
		expect(parseCustomRatio("1:3.01")).toBeNull();
		expect(parseCustomRatio("4:1")).toBeNull();
	});

	test("rejects malformed input", () => {
		for (const raw of [
			"",
			"abc",
			"16",
			"16:",
			":9",
			"16:9:1",
			"-16:9",
			"0:1",
			"1:0",
			"2.399:1",
			"1.001:1",
			"1e3:1",
			"1,5:1",
			".5:1",
			"16/9",
		]) {
			expect(parseCustomRatio(raw)).toBeNull();
		}
		expect(parseCustomRatio(null)).toBeNull();
		expect(parseCustomRatio(undefined)).toBeNull();
	});

	test("rejects a normalised form longer than 16 characters", () => {
		expect(parseCustomRatio("123456789:123456789")).toBeNull();
		expect(parseCustomRatio("1234567:1234567")).not.toBeNull(); // 15 chars
		expect(parseCustomRatio("9".repeat(200) + ":1")).toBeNull();
	});
});

describe("canvasSizeForRatio", () => {
	const size = (raw: string) => canvasSizeForRatio({ value: parsed(raw).value });

	test("matches the contract examples", () => {
		expect(size("16:9")).toEqual({ width: 1920, height: 1080 });
		expect(size("9:16")).toEqual({ width: 1080, height: 1920 });
		expect(size("2.39:1")).toEqual({ width: 1920, height: 804 });
		expect(size("1:1")).toEqual({ width: 1920, height: 1920 });
	});

	test("long side is 1920 and both sides are even", () => {
		for (const raw of ["5:4", "4:5", "1.85:1", "16:10", "3:1", "1:3", "1.33:1"]) {
			const { width, height } = size(raw);
			expect(Math.max(width, height)).toBe(1920);
			expect(width % 2).toBe(0);
			expect(height % 2).toBe(0);
		}
		expect(size("3:1")).toEqual({ width: 1920, height: 640 });
		expect(size("1:3")).toEqual({ width: 640, height: 1920 });
	});

	test("short side rounds to the nearest even number", () => {
		// 1920 / 1.85 = 1037.8 -> 1038
		expect(size("1.85:1").height).toBe(1038);
		// 1920 / 1.33 = 1443.6 -> 1444
		expect(size("1.33:1").height).toBe(1444);
	});
});

describe("isCanvasOfRatio", () => {
	test("tolerates even-rounding error but not a different ratio", () => {
		const value = parsed("2.39:1").value;
		expect(isCanvasOfRatio({ canvasSize: { width: 1920, height: 804 }, value })).toBe(true);
		expect(isCanvasOfRatio({ canvasSize: { width: 3840, height: 1608 }, value })).toBe(true);
		expect(isCanvasOfRatio({ canvasSize: { width: 1920, height: 1080 }, value })).toBe(false);
	});
});

describe("settingsForRatio", () => {
	test("custom canvas gets custom mode and a lock", () => {
		expect(settingsForRatio({ parsed: parsed("2.39:1") })).toEqual({
			canvasSize: { width: 1920, height: 804 },
			canvasSizeMode: "custom",
			lastCustomCanvasSize: { width: 1920, height: 804 },
			saturnCanvasLock: { ratio: "2.39:1" },
			saturnPlatformRatio: "2.39:1",
		});
	});

	test("a size equal to a preset uses preset mode, still locked", () => {
		expect(settingsForRatio({ parsed: parsed("16:9") })).toEqual({
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: "preset",
			saturnCanvasLock: { ratio: "16:9" },
			saturnPlatformRatio: "16:9",
		});
		expect(settingsForRatio({ parsed: parsed("9:16") }).canvasSizeMode).toBe(
			"preset",
		);
		expect(settingsForRatio({ parsed: parsed("1:1") }).canvasSizeMode).toBe(
			"custom", // 1920x1920 is not one of the presets
		);
	});
});

describe("planDraftRatioUpdate", () => {
	const wide = { width: 1920, height: 804 };
	const hd = { width: 1920, height: 1080 };
	const lock239 = { ratio: "2.39:1" };

	describe("no ratio", () => {
		test("leaves the draft alone, locked or not", () => {
			for (const custom of [true, false]) {
				expect(
					planDraftRatioUpdate({ settings: { canvasSize: hd }, parsed: null, custom }),
				).toBeNull();
				expect(
					planDraftRatioUpdate({
						settings: { canvasSize: wide, saturnCanvasLock: lock239 },
						parsed: null,
						custom,
					}),
				).toBeNull();
			}
		});
	});

	describe("custom ratio", () => {
		const custom = true;

		test("fresh draft with another canvas: canvas replaced, locked, recorded", () => {
			const patch = planDraftRatioUpdate({
				settings: { canvasSize: hd },
				parsed: parsed("2.39:1"),
				custom,
			});
			expect(patch?.canvasSize).toEqual(wide);
			expect(patch?.saturnCanvasLock).toEqual(lock239);
			expect(patch?.saturnPlatformRatio).toBe("2.39:1");
		});

		test("platform ratio changed: new canvas and lock, even over an old lock", () => {
			const patch = planDraftRatioUpdate({
				settings: {
					canvasSize: wide,
					saturnCanvasLock: lock239,
					saturnPlatformRatio: "2.39:1",
				},
				parsed: parsed("5:4"),
				custom,
			});
			expect(patch?.canvasSize).toEqual({ width: 1920, height: 1536 });
			expect(patch?.saturnCanvasLock).toEqual({ ratio: "5:4" });
			expect(patch?.saturnPlatformRatio).toBe("5:4");
		});

		test("user unlocked and the platform sends the same ratio: respected", () => {
			expect(
				planDraftRatioUpdate({
					settings: {
						canvasSize: hd,
						saturnCanvasLock: null,
						saturnPlatformRatio: "2.39:1",
					},
					parsed: parsed("2.39:1"),
					custom,
				}),
			).toBeNull();
		});

		test("user unlocked, then the platform ratio changed: applied again", () => {
			const patch = planDraftRatioUpdate({
				settings: {
					canvasSize: hd,
					saturnCanvasLock: null,
					saturnPlatformRatio: "2.39:1",
				},
				parsed: parsed("5:4"),
				custom,
			});
			expect(patch?.canvasSize).toEqual({ width: 1920, height: 1536 });
			expect(patch?.saturnCanvasLock).toEqual({ ratio: "5:4" });
		});

		test("matching canvas without a lock or record gains both, size untouched", () => {
			expect(
				planDraftRatioUpdate({
					settings: { canvasSize: { width: 3840, height: 1608 } },
					parsed: parsed("2.39:1"),
					custom,
				}),
			).toEqual({ saturnCanvasLock: lock239, saturnPlatformRatio: "2.39:1" });
		});

		test("already matching, locked and recorded: nothing to do", () => {
			expect(
				planDraftRatioUpdate({
					settings: {
						canvasSize: wide,
						saturnCanvasLock: lock239,
						saturnPlatformRatio: "2.39:1",
					},
					parsed: parsed("2.39:1"),
					custom,
				}),
			).toBeNull();
		});

		test("lock from before the record existed only gains the record", () => {
			expect(
				planDraftRatioUpdate({
					settings: { canvasSize: wide, saturnCanvasLock: lock239 },
					parsed: parsed("2.39:1"),
					custom,
				}),
			).toEqual({ saturnCanvasLock: lock239, saturnPlatformRatio: "2.39:1" });
		});
	});

	describe("preset ratio", () => {
		const custom = false;

		test("draft with the platform lock: released and canvas set to the preset", () => {
			const patch = planDraftRatioUpdate({
				settings: {
					canvasSize: wide,
					saturnCanvasLock: lock239,
					saturnPlatformRatio: "2.39:1",
				},
				parsed: parsed("16:9"),
				custom,
			});
			expect(patch).toEqual({
				canvasSize: { width: 1920, height: 1080 },
				canvasSizeMode: "preset",
				saturnCanvasLock: null,
				saturnPlatformRatio: "16:9",
			});
		});

		test("4:3 preset uses the long-side-1920 size", () => {
			const patch = planDraftRatioUpdate({
				settings: { canvasSize: wide, saturnCanvasLock: lock239 },
				parsed: parsed("4:3"),
				custom,
			});
			expect(patch?.canvasSize).toEqual({ width: 1920, height: 1440 });
			expect(patch?.saturnCanvasLock).toBeNull();
		});

		test("release keeps a canvas that already has the preset's ratio", () => {
			const patch = planDraftRatioUpdate({
				settings: {
					canvasSize: { width: 3840, height: 2160 },
					saturnCanvasLock: { ratio: "16:9" },
				},
				parsed: parsed("16:9"),
				custom,
			});
			expect(patch?.canvasSize).toBeUndefined();
			expect(patch?.saturnCanvasLock).toBeNull();
		});

		test("no lock (old draft or user unlocked): nothing", () => {
			expect(
				planDraftRatioUpdate({ settings: { canvasSize: hd }, parsed: parsed("16:9"), custom }),
			).toBeNull();
			expect(
				planDraftRatioUpdate({
					settings: { canvasSize: wide, saturnCanvasLock: null, saturnPlatformRatio: "16:9" },
					parsed: parsed("16:9"),
					custom,
				}),
			).toBeNull();
		});

		test("unlocked draft with a stale record: only the record is refreshed", () => {
			expect(
				planDraftRatioUpdate({
					settings: {
						canvasSize: hd,
						saturnCanvasLock: null,
						saturnPlatformRatio: "2.39:1",
					},
					parsed: parsed("16:9"),
					custom,
				}),
			).toEqual({ saturnPlatformRatio: "16:9" });
		});
	});
});
