import type { FrameRate } from "opencut-wasm";
import type { TScene } from "@/timeline/types";
import type { MediaTime } from "@/wasm";

export type TBackground =
	| {
			type: "color";
			color: string;
	  }
	| {
			type: "blur";
			blurIntensity: number;
	  };

export interface TCanvasSize {
	width: number;
	height: number;
}

export interface TProjectMetadata {
	id: string;
	name: string;
	thumbnail?: string;
	duration: MediaTime;
	createdAt: Date;
	updatedAt: Date;
	/**
	 * Which AI-Saturn project this editor project was opened from, if any.
	 *
	 * Optional and additive: projects created directly in the editor carry no
	 * upstream owner, and their rows simply lack the field. Kept on metadata
	 * rather than settings because `loadAllProjectsMetadata` reads metadata
	 * alone — the draft list can group by upstream project without loading a
	 * single scene.
	 */
	saturnProjectId?: number;
	/**
	 * Stamped once the AI-Saturn shot list has actually been laid out onto this
	 * project's timeline.
	 *
	 * A project record is created before the placeholders are inserted, so a
	 * failure in between leaves a real, reusable project with an empty scene.
	 * The landing page needs to tell that husk from a draft the user has
	 * genuinely built, and duration cannot answer it: every save recomputes
	 * duration from the live scenes, so a user who deletes all their clips
	 * would look identical to a project that never got built.
	 *
	 * Absent means "never laid out". Set once, never cleared — clearing the
	 * timeline later is the user's choice and must not send them back through
	 * the creation path.
	 */
	saturnLaidOut?: true;
}

/**
 * Marks a canvas that AI-Saturn fixed from the project's own aspect ratio.
 *
 * Additive and optional: projects created before this, and projects made
 * directly in the editor, simply lack the field and behave exactly as before.
 * While present, the first clip dropped on the timeline no longer rewrites the
 * canvas, and video clips fill the frame (cover) instead of fitting inside it.
 */
export interface TSaturnCanvasLock {
	/** Normalised ratio string as sent by the platform, e.g. "2.39:1". */
	ratio: string;
}

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
	/** `null` is an explicit release (the user took the canvas back). */
	saturnCanvasLock?: TSaturnCanvasLock | null;
	/**
	 * The ratio AI-Saturn last handed this project (normalised), kept even
	 * after the lock is released. It is how a reopen tells "the platform sent
	 * the same ratio again" (respect the user's own canvas) from "the project's
	 * ratio was changed on the platform" (apply it).
	 */
	saturnPlatformRatio?: string;
	background: TBackground;
}

export interface TTimelineViewState {
	zoomLevel: number;
	scrollLeft: number;
	playheadTime: MediaTime;
}

export interface TProject {
	metadata: TProjectMetadata;
	scenes: TScene[];
	currentSceneId: string;
	settings: TProjectSettings;
	version: number;
	timelineViewState?: TTimelineViewState;
}

export type TProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type TSortOrder = "asc" | "desc";
export type TProjectSortOption = `${TProjectSortKey}-${TSortOrder}`;
