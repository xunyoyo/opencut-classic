"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useEditor } from "@/editor/use-editor";
import { storeSaturnToken } from "@/saturn/session";
import {
	importSaturnView,
	type ImportProgress,
} from "@/saturn/import";
import { fetchSaturnProjects, fetchSaturnViews } from "@/saturn/projects";
import type { SaturnProject, SaturnView } from "@/saturn/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ImportState =
	| { status: "idle" }
	| { status: "running"; progress: ImportProgress }
	| { status: "failed"; message: string };

type SelectState =
	| { step: "projects"; loading: boolean; error: string | null; projects: SaturnProject[] }
	| { step: "views"; loading: boolean; error: string | null; project: SaturnProject; views: SaturnView[] };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function viewLabel(view: SaturnView): string {
	const ep = view.seriesNo != null ? `第${view.seriesNo}集` : "";
	const scene = view.viewNo != null
		? `第${view.viewNo}${view.viewNoSurffix ?? ""}场`
		: `场次 ${view.viewId}`;
	return [ep, scene].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// No params — project/view selector
// ---------------------------------------------------------------------------

function ProjectViewSelector({
	token,
	onSelect,
}: {
	token: string;
	onSelect: (project: SaturnProject, view: SaturnView) => void;
}) {
	const [state, setState] = useState<SelectState>({
		step: "projects",
		loading: true,
		error: null,
		projects: [],
	});

	// Load projects on mount
	useEffect(() => {
		let cancelled = false;
		fetchSaturnProjects({ token })
			.then((projects) => {
				if (!cancelled) {
					setState({ step: "projects", loading: false, error: null, projects });
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setState({
						step: "projects",
						loading: false,
						error: err instanceof Error ? err.message : "加载项目列表失败",
						projects: [],
					});
				}
			});
		return () => { cancelled = true; };
	}, [token]);

	const selectProject = useCallback(
		(project: SaturnProject) => {
			setState({ step: "views", loading: true, error: null, project, views: [] });
			fetchSaturnViews({ token, projectId: project.projectId })
				.then((views) => {
					setState({ step: "views", loading: false, error: null, project, views });
				})
				.catch((err: unknown) => {
					setState({
						step: "views",
						loading: false,
						error: err instanceof Error ? err.message : "加载场次列表失败",
						project,
						views: [],
					});
				});
		},
		[token],
	);

	const backToProjects = useCallback(() => {
		setState((prev) =>
			prev.step === "views"
				? { step: "projects", loading: false, error: null, projects: [] }
				: prev,
		);
		// Re-fetch on back
		fetchSaturnProjects({ token })
			.then((projects) => {
				setState({ step: "projects", loading: false, error: null, projects });
			})
			.catch(() => {});
	}, [token]);

	if (state.step === "projects") {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<h1 className="text-xl font-semibold">选择项目</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					选择一个 AI-Saturn 项目，然后选取要导入的场次。
				</p>
				<div className="mt-6 space-y-2">
					{state.loading ? (
						<>
							<Skeleton className="h-14 w-full rounded-lg" />
							<Skeleton className="h-14 w-full rounded-lg" />
							<Skeleton className="h-14 w-full rounded-lg" />
						</>
					) : state.error ? (
						<ErrorCard message={state.error} />
					) : state.projects.length === 0 ? (
						<p className="text-sm text-muted-foreground">暂无项目</p>
					) : (
						state.projects.map((project) => (
							<button
								key={project.projectId}
								type="button"
								onClick={() => selectProject(project)}
								className="flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{project.logo ? (
									// eslint-disable-next-line @next/next/no-img-element
									<img
										src={project.logo}
										alt=""
										className="mt-0.5 h-8 w-8 shrink-0 rounded object-cover"
									/>
								) : (
									<span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">
										{project.projectName.slice(0, 2)}
									</span>
								)}
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">{project.projectName}</p>
									{project.summary && (
										<p className="mt-0.5 truncate text-xs text-muted-foreground">
											{project.summary}
										</p>
									)}
								</div>
							</button>
						))
					)}
				</div>
			</div>
		);
	}

	// step === "views"
	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<button
				type="button"
				onClick={backToProjects}
				className="mb-4 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
			>
				← 返回项目列表
			</button>
			<h1 className="text-xl font-semibold">{state.project.projectName}</h1>
			<p className="mt-2 text-sm text-muted-foreground">选择要导入的场次</p>
			<div className="mt-6 space-y-2">
				{state.loading ? (
					<>
						<Skeleton className="h-12 w-full rounded-lg" />
						<Skeleton className="h-12 w-full rounded-lg" />
						<Skeleton className="h-12 w-full rounded-lg" />
					</>
				) : state.error ? (
					<ErrorCard message={state.error} />
				) : state.views.length === 0 ? (
					<p className="text-sm text-muted-foreground">该项目暂无场次</p>
				) : (
					state.views.map((view) => (
						<button
							key={view.viewId}
							type="button"
							onClick={() => onSelect(state.project, view)}
							className="flex w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="text-sm font-medium">{viewLabel(view)}</span>
							{view.mainContent && (
								<span className="ml-4 max-w-[55%] truncate text-xs text-muted-foreground">
									{view.mainContent}
								</span>
							)}
						</button>
					))
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Small error card
// ---------------------------------------------------------------------------

function ErrorCard({ message }: { message: string }) {
	return (
		<div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
			{message}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Missing params explainer
// ---------------------------------------------------------------------------

function MissingParams() {
	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">从 AI-Saturn 导入</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				这个页面需要由 AI-Saturn 跳转进来，URL 上要带登录态：
			</p>
			<pre className="mt-4 overflow-x-auto rounded-md bg-muted p-4 text-xs">
				{`/saturn-import?token=Bearer%20xxx
/saturn-import?viewId=123&type=1&token=Bearer%20xxx`}
			</pre>
			<dl className="mt-4 space-y-1 text-sm text-muted-foreground">
				<div>
					<dt className="inline font-medium">token</dt>
					<dd className="inline"> —— AI-Saturn 的登录令牌（必填）</dd>
				</div>
				<div>
					<dt className="inline font-medium">viewId</dt>
					<dd className="inline"> —— AI-Saturn 的场次 ID（不填则弹出选择器）</dd>
				</div>
				<div>
					<dt className="inline font-medium">type</dt>
					<dd className="inline"> —— 1 九宫格分镜，2 故事板分镜（默认 1）</dd>
				</div>
				<div>
					<dt className="inline font-medium">name</dt>
					<dd className="inline"> —— 可选，项目名</dd>
				</div>
			</dl>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Import progress screen
// ---------------------------------------------------------------------------

function ImportScreen({
	state,
	onRetry,
}: {
	state: ImportState;
	onRetry: () => void;
}) {
	if (state.status === "failed") {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<h1 className="text-xl font-semibold">导入失败</h1>
				<p className="mt-3 text-sm text-muted-foreground">{state.message}</p>
				<Button className="mt-6" onClick={onRetry}>
					重试
				</Button>
			</div>
		);
	}

	const ratio = state.status === "running" ? state.progress.ratio : null;

	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">正在从 AI-Saturn 导入</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				{state.status === "running" ? state.progress.label : "正在准备…"}
			</p>
			<div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className="h-full rounded-full bg-primary transition-all duration-300"
					style={{
						width: ratio === null ? "100%" : `${Math.round(ratio * 100)}%`,
						opacity: ratio === null ? 0.4 : 1,
					}}
				/>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function SaturnImport() {
	const editor = useEditor();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [importState, setImportState] = useState<ImportState>({ status: "idle" });

	const viewIdParam = searchParams.get("viewId");
	const viewId = viewIdParam ? Number(viewIdParam) : Number.NaN;
	const type = Number(searchParams.get("type") ?? "1");
	const token = searchParams.get("token");
	const nameParam = searchParams.get("name");
	const autoCaption = searchParams.get("captions") !== "0";

	const hasStarted = useRef(false);

	const runImport = useCallback(
		async (targetViewId: number, projectName: string) => {
			if (!token) return;
			storeSaturnToken({ token });

			setImportState({
				status: "running",
				progress: { label: "正在准备…", ratio: null },
			});

			try {
				const result = await importSaturnView({
					editor,
					viewId: targetViewId,
					type,
					token,
					projectName,
					onProgress: ({ progress }) => {
						setImportState({ status: "running", progress });
					},
				});

				if (autoCaption) {
					useAssetsPanelStore.getState().requestAutoCaption();
				}

				router.replace(`/editor/${result.projectId}`);
			} catch (error) {
				setImportState({
					status: "failed",
					message:
						error instanceof Error ? error.message : "导入失败，请稍后重试",
				});
			}
		},
		[editor, router, type, token, autoCaption],
	);

	// Direct jump with viewId — start immediately, same as before
	useEffect(() => {
		if (!token || !Number.isFinite(viewId)) return;
		if (hasStarted.current) return;
		hasStarted.current = true;
		const projectName = nameParam ?? `AI-Saturn 场次 ${viewIdParam ?? ""}`.trim();
		void runImport(viewId, projectName);
	}, [runImport, viewId, viewIdParam, token, nameParam]);

	// No token at all — show explainer
	if (!token) {
		return <MissingParams />;
	}

	// Import in progress or failed
	if (importState.status !== "idle" || Number.isFinite(viewId)) {
		return (
			<ImportScreen
				state={importState}
				onRetry={() => {
					if (Number.isFinite(viewId)) {
						hasStarted.current = false;
						setImportState({ status: "idle" });
						const projectName =
							nameParam ?? `AI-Saturn 场次 ${viewIdParam ?? ""}`.trim();
						void runImport(viewId, projectName);
					} else {
						setImportState({ status: "idle" });
					}
				}}
			/>
		);
	}

	// No viewId — show project/view selector
	return (
		<ProjectViewSelector
			token={token}
			onSelect={(project, view) => {
				const projectName =
					nameParam ??
					`${project.projectName} · ${viewLabel(view)}`;
				void runImport(view.viewId, projectName);
			}}
		/>
	);
}

export default function SaturnImportPage() {
	return (
		<Suspense fallback={null}>
			<SaturnImport />
		</Suspense>
	);
}
