import type { TProject } from "@/project/types";
import { generateUUID } from "@/utils/id";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { TScene } from "@/timeline/types";
import { serializeProject } from "./serialize";
import {
	deleteVersion,
	listVersions,
	loadVersion,
	markVersionCurrent,
	saveVersion,
	type ListVersionsResult,
} from "./store";
import {
	collectMediaIds,
	getUnrecoverableReason,
	hasExternalMediaReference,
	type ProjectVersion,
	type ProjectVersionSummary,
} from "./types";

export type ApplyVersionResult =
	| { ok: true; warnings: string[] }
	| { ok: false; reason: string };

/**
 * The slice of `EditorCore` this manager actually uses.
 *
 * Declared explicitly rather than taking the whole `EditorCore`, for two
 * reasons. It documents the real dependency surface — four calls across three
 * managers — which is otherwise invisible in the constructor signature. And it
 * makes the manager constructible from a substitute: `EditorCore` is a
 * singleton with a private constructor, so anything that needs to drive this
 * class in a test has to do so without one, and a narrowed parameter type is
 * what allows that without an assertion.
 *
 * `EditorCore` satisfies this structurally, so `new VersionManager(editor)`
 * in `core/index.ts` is unaffected.
 */
export interface VersionManagerHost {
	project: {
		getActiveOrNull(): TProject | null;
		setActiveProject(args: { project: TProject }): void;
	};
	scenes: {
		getScenes(): TProject["scenes"];
		initializeScenes(args: { scenes: TScene[]; currentSceneId?: string }): void;
	};
	save: {
		flush(): Promise<void>;
		markDirty(args?: { force?: boolean }): void;
	};
}

/**
 * The editor-facing half of version history.
 *
 * Reachable as `editor.versions`, alongside the other managers, because saving
 * a version has to do three things no single existing manager owns: flush the
 * debounced save, read the live scenes rather than the project record, and
 * write to the version store.
 */
export class VersionManager {
	constructor(private editor: VersionManagerHost) {}

	async list(): Promise<ListVersionsResult> {
		const project = this.editor.project.getActiveOrNull();
		if (!project) return { ok: true, versions: [] };
		return await listVersions({ projectId: project.metadata.id });
	}

	/**
	 * Snapshots the project as it stands now.
	 *
	 * `flush()` first: scenes live in memory until the debounced save runs, so
	 * snapshotting without it could capture a version older than what the user
	 * is looking at — and the restore path relies on this being exact.
	 */
	async save({
		name = "",
		isAuto = false,
	}: {
		name?: string;
		isAuto?: boolean;
	} = {}): Promise<ProjectVersion | null> {
		const project = this.editor.project.getActiveOrNull();
		if (!project) return null;

		await this.editor.save.flush();

		// Scenes come from the scenes manager, not `project.scenes`: that field
		// is the record read at load time, and every edit since has gone through
		// `scenes`. `saveCurrentProject` reads them the same way, for the same
		// reason — a snapshot built from `project.scenes` would silently be the
		// state from when the project was opened.
		const liveProject = { ...project, scenes: this.editor.scenes.getScenes() };
		const snapshot = serializeProject({
			project: liveProject,
			duration:
				liveProject.metadata.duration ??
				getProjectDurationFromScenes({ scenes: liveProject.scenes }),
		});

		const version: ProjectVersion = {
			id: generateUUID(),
			projectId: project.metadata.id,
			name,
			createdAt: Date.now(),
			isCurrent: true,
			mediaIds: collectMediaIds({ snapshot }),
			appVersion: CURRENT_PROJECT_VERSION,
			isAuto,
			snapshot,
		};

		await saveVersion({ version });
		// The new version is now the one matching the project, so any previous
		// holder of the flag has to give it up.
		await markVersionCurrent({
			projectId: version.projectId,
			versionId: version.id,
		});

		return version;
	}

	/**
	 * Replaces the current project content with a saved version's.
	 *
	 * Auto-snapshots the current state first. This is not a nicety: applying a
	 * version overwrites the timeline in place, so without that snapshot one
	 * click would destroy whatever the user had unsaved. Restoring is the exact
	 * case where the previous state is hardest to reconstruct by hand.
	 */
	async apply({
		versionId,
	}: {
		versionId: string;
	}): Promise<ApplyVersionResult> {
		const project = this.editor.project.getActiveOrNull();
		if (!project) return { ok: false, reason: "没有打开的项目" };

		const projectId = project.metadata.id;
		const target = await loadVersion({ projectId, versionId });
		if (!target) return { ok: false, reason: "未找到该版本，可能已被删除" };

		const unrecoverable = getUnrecoverableReason({
			version: { ...target, mediaCount: target.mediaIds.length },
			currentAppVersion: CURRENT_PROJECT_VERSION,
		});
		if (unrecoverable) return { ok: false, reason: unrecoverable };

		const safety = await this.save({ isAuto: true });
		if (!safety) return { ok: false, reason: "无法快照当前状态，已取消恢复" };

		const warnings: string[] = [];
		if (hasExternalMediaReference({ snapshot: target.snapshot })) {
			warnings.push(
				"该版本包含来自音效库的音频，其在线链接可能已失效，恢复后需要检查。",
			);
		}

		const restoredScenes = deserializeScenes({ snapshot: target.snapshot });

		// Media assets are deliberately NOT cleared. `loadProject()` clears them
		// because it switches projects and the assets belong to the project id;
		// restoring a version stays inside the same project, and the snapshot
		// references media by the very ids already in this project's OPFS
		// directory. Clearing them here would delete the user's footage from a
		// dialog that promises to restore their work.
		this.editor.scenes.initializeScenes({
			scenes: restoredScenes,
			currentSceneId: target.snapshot.currentSceneId,
		});

		this.editor.project.setActiveProject({
			project: {
				...project,
				scenes: restoredScenes,
				currentSceneId:
					target.snapshot.currentSceneId || project.currentSceneId,
				settings: target.snapshot.settings ?? project.settings,
				timelineViewState:
					target.snapshot.timelineViewState ?? project.timelineViewState,
			},
		});

		// Flag follows the restore so the list marks the version the user is
		// now looking at, rather than the auto-snapshot taken moments ago.
		await markVersionCurrent({ projectId, versionId });

		// The restored content differs from the persisted project record, so it
		// has to be written back — otherwise a reload would look like the
		// restore never happened.
		this.editor.save.markDirty({ force: true });
		await this.editor.save.flush();

		return { ok: true, warnings };
	}

	async remove({ versionId }: { versionId: string }): Promise<void> {
		const project = this.editor.project.getActiveOrNull();
		if (!project) return;
		await deleteVersion({ projectId: project.metadata.id, versionId });
	}

	currentAppVersion(): number {
		return CURRENT_PROJECT_VERSION;
	}
}

/**
 * Rebuilds live scenes from a snapshot.
 *
 * Mirrors the scene reconstruction in `service.ts`'s `loadProject`, which is
 * the other place a stored scene becomes a live one — the two must agree on
 * what a persisted scene means. Dates come back from ISO strings, because the
 * scene list carries `Date` objects and passing the strings through would
 * surface as an invalid date rather than an error.
 */
function deserializeScenes({
	snapshot,
}: {
	snapshot: ProjectVersion["snapshot"];
}): TScene[] {
	return (snapshot.scenes ?? []).map((scene) => ({
		id: scene.id,
		name: scene.name,
		isMain: scene.isMain,
		tracks: scene.tracks,
		bookmarks: scene.bookmarks,
		createdAt: new Date(scene.createdAt),
		updatedAt: new Date(scene.updatedAt),
	}));
}

export type { ProjectVersionSummary };
