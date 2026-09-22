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

export interface TProjectSettings {
	fps: FrameRate;
	canvasSize: TCanvasSize;
	canvasSizeMode?: "preset" | "custom";
	lastCustomCanvasSize?: TCanvasSize | null;
	originalCanvasSize?: TCanvasSize | null;
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
