import type {
	SerializedProject,
	SerializedScene,
} from "@/services/storage/types";
import type { ProjectVersion } from "@/versions/types";
import { buildScene, tick } from "./scene-fixtures";

export {
	buildLiveScene,
	buildScene,
	buildSceneTracks,
	tick,
} from "./scene-fixtures";

export function buildSnapshot({
	scenes = [buildScene()],
	currentSceneId = "scene-1",
}: {
	scenes?: SerializedScene[];
	currentSceneId?: string;
} = {}): SerializedProject {
	return {
		metadata: {
			id: "project-1",
			name: "测试项目",
			duration: tick({ value: 500 }),
			createdAt: "2024-01-01T00:00:00.000Z",
			updatedAt: "2024-01-01T00:00:00.000Z",
		},
		scenes,
		currentSceneId,
		settings: {
			// `FrameRate` is a rational, not a number.
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: 31,
	};
}

export function buildVersion({
	id,
	projectId = "project-1",
	name = "",
	createdAt = 1_700_000_000_000,
	isCurrent = false,
	isAuto = false,
	appVersion = 31,
	mediaIds = [] as string[],
	snapshot,
}: {
	id: string;
	projectId?: string;
	name?: string;
	createdAt?: number;
	isCurrent?: boolean;
	isAuto?: boolean;
	appVersion?: number;
	mediaIds?: string[];
	snapshot?: SerializedProject;
}): ProjectVersion {
	return {
		id,
		projectId,
		name,
		createdAt,
		isCurrent,
		mediaIds,
		appVersion,
		isAuto,
		snapshot: snapshot ?? buildSnapshot(),
	};
}
