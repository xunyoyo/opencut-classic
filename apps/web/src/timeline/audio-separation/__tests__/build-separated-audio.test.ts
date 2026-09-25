import { describe, expect, test } from "bun:test";
import type { UploadAudioElement, VideoElement } from "@/timeline/types";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { buildSeparatedAudioElement } from "@/timeline/audio-separation";
import { DEFAULTS } from "@/timeline/defaults";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildVideoElement(): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "clip",
		startTime: mediaTime({ ticks: 0 }),
		duration: mediaTime({ ticks: 5000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 5000 }),
		mediaId: "media-1",
		params: {
			volume: 1,
			muted: false,
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
	};
}

function buildEmptyTracks() {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "main",
			type: "video" as const,
			muted: false,
			hidden: false,
			elements: [] as VideoElement[],
		},
		audio: [],
	};
}

describe("buildSeparatedAudioElement", () => {
	test("stamps the source element id on the derived audio", () => {
		const sourceElement = buildVideoElement();

		const derived = buildSeparatedAudioElement({ sourceElement });

		expect(derived.derivedFromElementId).toBe("video-1");
		expect(derived.mediaId).toBe("media-1");
		expect(derived.type).toBe("audio");
	});

	test("mirrors the source timing and volume", () => {
		const sourceElement = buildVideoElement();

		const derived = buildSeparatedAudioElement({ sourceElement });

		expect(derived.startTime).toBe(sourceElement.startTime);
		expect(derived.duration).toBe(sourceElement.duration);
		expect(derived.trimStart).toBe(sourceElement.trimStart);
		expect(derived.params.volume).toBe(1);
	});

	test("falls back to the default volume when the source has none", () => {
		const sourceElement = buildVideoElement();
		const { volume: _dropped, ...paramsWithoutVolume } = sourceElement.params;
		const withoutVolume: VideoElement = {
			...sourceElement,
			params: paramsWithoutVolume,
		};

		const derived = buildSeparatedAudioElement({
			sourceElement: withoutVolume,
		});

		expect(derived.params.volume).toBe(DEFAULTS.element.volume);
	});

	test("keeps the pointer through applyPlacement", () => {
		const sourceElement = buildVideoElement();
		const derived: UploadAudioElement = {
			...buildSeparatedAudioElement({ sourceElement }),
			id: "derived-1",
		};
		const tracks = buildEmptyTracks();

		const placementResult = resolveTrackPlacement({
			tracks,
			trackType: "audio",
			timeSpans: [{ startTime: derived.startTime, duration: derived.duration }],
			strategy: { type: "firstAvailable" },
		});
		expect(placementResult).not.toBeNull();
		if (!placementResult) return;

		const applied = applyPlacement({
			tracks,
			placementResult,
			elements: [derived],
		});
		expect(applied).not.toBeNull();
		if (!applied) return;

		const placed = applied.updatedTracks.audio[0]?.elements[0];
		expect(placed?.id).toBe("derived-1");
		expect(
			placed && "derivedFromElementId" in placed
				? placed.derivedFromElementId
				: undefined,
		).toBe("video-1");
	});
});
