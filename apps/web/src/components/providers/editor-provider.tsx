"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { useKeybindingsStore } from "@/actions/keybindings-store";
import { useTimelineStore } from "@/timeline/timeline-store";
import { useEditorActions } from "@/actions/use-editor-actions";
import { loadFontAtlas } from "@/fonts/google-fonts";
import {
	clearPendingOpen,
	loadImportedShotIds,
	loadShotPrefetch,
	readPendingOpen,
	takeShotHandoff,
} from "@/saturn/project-shots";
import { importSaturnShotMedia } from "@/saturn/media-import";
import { projectShotSegments } from "@/saturn/types";
import {
	initializeGpuRenderer,
	isGpuAvailable,
} from "@/services/renderer/gpu-renderer";

interface EditorProviderProps {
	projectId: string;
	children: React.ReactNode;
}

/**
 * Marks a project id that does not exist yet and should be created on arrival.
 * See /saturn-open — the landing page cannot create projects itself.
 */
const PENDING_ID_PREFIX = "new-";

/**
 * Saturn project ids currently being created into a local draft.
 *
 * React StrictMode re-runs this effect in development, and the project load it
 * awaits cannot be cancelled, so both runs reach the not-found branch. Without
 * this, one `new-42` navigation creates two projects and the second
 * `router.replace` wins, leaving an orphan behind. Module-level rather than a
 * ref because the two runs are different effect instances.
 */
const creationsInFlight = new Set<number>();

export function EditorProvider({ projectId, children }: EditorProviderProps) {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const router = useRouter();
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const { setLoadingProject } = useKeybindingsStore();

	useEffect(() => {
		setLoadingProject(isLoading);
	}, [isLoading, setLoadingProject]);

	useEffect(() => {
		let cancelled = false;
		const editor = EditorCore.getInstance();

		const loadProject = async () => {
			try {
				setIsLoading(true);
				await initializeGpuRenderer();
				editor.renderer.setDegraded(!isGpuAvailable());
				await editor.project.loadProject({ id: projectId });

				if (cancelled) return;

				setIsLoading(false);
				loadFontAtlas();
			} catch (err) {
				if (cancelled) return;

				const isNotFound =
					err instanceof Error &&
					(err.message.includes("not found") ||
						err.message.includes("does not exist"));

				if (isNotFound) {
					// The landing page routes a not-yet-created AI-Saturn project
					// here as `new-<saturnProjectId>`. Only that shape creates a
					// project: a mistyped id should not silently spawn one.
					if (projectId.startsWith(PENDING_ID_PREFIX)) {
						const saturnProjectId = Number(
							projectId.slice(PENDING_ID_PREFIX.length),
						);
						const pending = readPendingOpen();

						// A marker that exists and names a *different* project is the
						// one case worth refusing: acting on it would file this
						// project's draft under someone else's id.
						//
						// A *missing* marker is not refused. markPendingOpen swallows
						// its own write failure, so private mode or a full
						// localStorage leaves the legitimate path with nothing
						// parked — and the URL alone already carries the upstream id.
						// The name is then recovered from the prefetch, which is
						// written by the same page that parks the marker.
						if (pending && pending.saturnProjectId !== saturnProjectId) {
							setError("这个新建链接已失效，请重新从 AI-Saturn 的「剪辑」进入");
							setIsLoading(false);
							return;
						}

						const prefetch = loadShotPrefetch({
							projectId: saturnProjectId,
						});
						const projectName = pending?.projectName ?? prefetch?.projectName;

						// The in-memory handoff carries the shots forward without a
						// JSON round trip, but a full page load drops it — the
						// persisted prefetch is the fallback, and is also what makes
						// a retry after a failed creation work.
						const shots =
							takeShotHandoff({ saturnProjectId }) ?? prefetch?.shots ?? null;

						// Refused rather than created empty. A project made without
						// shots would persist this saturnProjectId with nothing to
						// show, and the landing page would then find it and reuse it
						// forever — the user would never see their footage. Failing
						// here leaves the retry free to do it properly.
						//
						// Checked in segments: a tree of nothing but container shots
						// would pass a node count and still lay down an empty
						// timeline.
						if (!shots || projectShotSegments(shots).length === 0) {
							setError(
								"没有取到这个项目的分镜数据，请重新从 AI-Saturn 的「剪辑」进入",
							);
							setIsLoading(false);
							return;
						}

						// Claimed before the await, released in `finally`. The flag is
						// not what protects against a retry creating a second project
						// — the layout stamp on the landing page does that. This only
						// closes the window where two runs of this effect overlap,
						// and holding it past that would leave the page inert.
						if (creationsInFlight.has(saturnProjectId)) return;
						creationsInFlight.add(saturnProjectId);

						try {
							const newProjectId = await editor.project.createNewProject({
								name: projectName ?? "无标题项目",
								saturnProjectId,
							});

							// Past this point the project exists, so the intent has
							// been acted on and a retry must not create a second one.
							clearPendingOpen();

							// No download happens here. Routing straight into the
							// editor beats holding a loading screen in front of a
							// project's worth of footage, and the import is not on
							// the critical path any more now that nothing is placed
							// on the timeline. SaturnMediaSync picks the renders up
							// the moment the editor is mounted — which is also why
							// this must stay out of here: two importers running at
							// once would both find an empty "already imported" set
							// and download everything twice.
							//
							// Stamped before the save so the layout and the stamp land
							// in one write: the landing page uses the stamp to tell a
							// half-built project from a finished one.
							editor.project.markSaturnLayoutComplete();
							await editor.project.saveCurrentProject();

							router.replace(`/editor/${newProjectId}`);
						} catch (_createErr) {
							// Creation failed outright, or the layout did after it.
							// Either way the marker is deliberately left in place, so
							// the retry still knows the project name and upstream id.
							// A project created before a layout failure stays behind
							// without the layout stamp, and the landing page skips
							// unstamped drafts — so the retry rebuilds rather than
							// reusing a half-built timeline.
							setError("创建项目失败");
							setIsLoading(false);
						} finally {
							creationsInFlight.delete(saturnProjectId);
						}
						return;
					}

					// Some other unknown id. The editor has always created an
					// untitled project for these; left as it was.
					try {
						const newProjectId = await editor.project.createNewProject({
							name: "无标题项目",
						});
						router.replace(`/editor/${newProjectId}`);
					} catch (_createErr) {
						setError("创建项目失败");
						setIsLoading(false);
					}
				} else {
					const wasmPanic = (window as Window & { __wasmPanic?: string })
						.__wasmPanic;
					if (wasmPanic) {
						delete (window as Window & { __wasmPanic?: string }).__wasmPanic;
						setError(wasmPanic);
					} else {
						setError(
							err instanceof Error ? err.message : "加载项目失败",
						);
					}
					setIsLoading(false);
				}
			}
		};

		loadProject();

		return () => {
			cancelled = true;
		};
	}, [projectId, router]);

	if (error) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<p className="text-destructive text-sm">{error}</p>
				</div>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex w-full max-w-sm flex-col items-center gap-4 px-6">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">正在加载项目…</p>
				</div>
			</div>
		);
	}

	if (!activeProject) {
		return (
			<div className="bg-background flex h-screen w-screen items-center justify-center">
				<div className="flex flex-col items-center gap-4">
					<Loader2 className="text-muted-foreground size-8 animate-spin" />
					<p className="text-muted-foreground text-sm">正在退出项目…</p>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorRuntimeBindings />
			<SaturnMediaSync />
			{children}
		</>
	);
}

/**
 * Editor projects with a media import currently running.
 *
 * The effect below can be entered twice for the same project — StrictMode
 * re-runs effects in development, and the active project is assigned again as
 * the editor finishes loading. Two importers would each find an empty "already
 * imported" set and download the whole project twice, and since every clip is
 * decoded on the main thread the doubled work does not even run in parallel:
 * the two runs starve each other and the progress bar stops moving.
 *
 * Module-level rather than a ref for the same reason as `creationsInFlight`:
 * the overlapping runs are different effect instances, so no single ref sees
 * both.
 */
const mediaImportsInFlight = new Set<string>();

/**
 * Tops up the media library with renders that landed since the project was last
 * opened.
 *
 * Driven off the active project rather than off "a project was just created", so
 * a reload in the middle of a long download picks up the rest instead of
 * dependending on the one-time creation branch. The timeline is never written to
 * — anything the user has already cut together stays exactly as they left it.
 *
 * Runs in the background while the editor stays usable, and only ever fetches
 * shots it has not imported before.
 */
function SaturnMediaSync() {
	const project = useEditor((e) => e.project.getActiveOrNull());

	const saturnProjectId = project?.metadata.saturnProjectId;
	const editorProjectId = project?.metadata.id;

	useEffect(() => {
		if (saturnProjectId === undefined || !editorProjectId) return;

		const prefetch = loadShotPrefetch({ projectId: saturnProjectId });
		if (!prefetch) return;

		// Nothing rendered yet — the prefetch holds the structure, not any video.
		const rendered = projectShotSegments(prefetch.shots).filter(
			(shot) => typeof shot.videoUrl === "string" && shot.videoUrl.length > 0,
		);
		if (rendered.length === 0) return;

		// Compared per shot rather than by count: the prefetch is refetched on
		// every visit from the platform, so a project that has rendered more
		// shots since the last import would look "complete" on a count that
		// happened to match while the new ones were still missing. The importer
		// skips whatever is already recorded, so only the new shots cost anything.
		const imported = loadImportedShotIds({ projectId: editorProjectId });
		const pending = rendered.filter((shot) => !imported.has(shot.shotId));
		if (pending.length === 0) return;

		if (mediaImportsInFlight.has(editorProjectId)) return;
		mediaImportsInFlight.add(editorProjectId);

		const controller = new AbortController();
		const editor = EditorCore.getInstance();

		// The editor is already usable by the time this runs, so the progress
		// belongs in a corner rather than on a screen the user cannot leave.
		// A single toast id lets each update replace the last one instead of
		// stacking one per shot.
		const toastId = toast.loading(`正在导入成片（0/${pending.length}）`);

		// Every update re-renders the toast subtree, and the importer reports
		// once per shot with three shots in flight. At a few files it is free;
		// on a project with hundreds it competes with the decode that is the
		// actual bottleneck, so the label is only rewritten when it changes.
		let lastLabel = "";

		void importSaturnShotMedia({
			editor,
			projectId: editorProjectId,
			shots: prefetch.shots,
			signal: controller.signal,
			onProgress: ({ done, total }) => {
				const label = `正在导入成片（${done}/${total}）`;
				if (label === lastLabel) return;
				lastLabel = label;
				toast.loading(label, { id: toastId });
			},
		})
			.then((byShotId) => {
				if (controller.signal.aborted) return;

				if (byShotId.size === 0) {
					toast.info("没有可导入的成片", { id: toastId });
					return;
				}
				toast.success(`素材库新增 ${byShotId.size} 个成片`, { id: toastId });
			})
			.catch(() => {
				if (controller.signal.aborted) return;
				// Individual failures are logged and skipped by the importer, so
				// reaching here means the whole run fell over — worth saying.
				toast.error("成片导入中断，可重新进入项目继续", { id: toastId });
			})
			.finally(() => {
				// An aborted run resolved early rather than doing work, so it must
				// not clear the flag: by the time its `finally` lands, the run that
				// replaced it may already have claimed the same id.
				if (controller.signal.aborted) return;
				mediaImportsInFlight.delete(editorProjectId);
			});

		return () => {
			controller.abort();
			toast.dismiss(toastId);
			mediaImportsInFlight.delete(editorProjectId);
		};
	}, [saturnProjectId, editorProjectId]);

	return null;
}

function EditorRuntimeBindings() {
	const editor = useEditor();
	const rippleEditingEnabled = useTimelineStore(
		(state) => state.rippleEditingEnabled,
	);

	useEffect(() => {
		editor.command.isRippleEnabled = rippleEditingEnabled;
	}, [editor, rippleEditingEnabled]);

	useEffect(() => {
		const handleBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!editor.save.getIsDirty()) return;
			event.preventDefault();
			(event as unknown as { returnValue: string }).returnValue = "";
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [editor]);

	useEditorActions();
	useKeybindingsListener();
	return null;
}
