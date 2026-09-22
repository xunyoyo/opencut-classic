"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { storeSaturnToken } from "@/saturn/session";
import { readBrandFromParams, saveBrand } from "@/saturn/brand";
import {
	fetchSaturnProjectShots,
	listShotPrefetches,
	markPendingOpen,
	saveShotPrefetch,
	setShotHandoff,
	type SaturnShotPrefetch,
} from "@/saturn/project-shots";
import { projectShotSegments } from "@/saturn/types";
import { storageService } from "@/services/storage/service";
import type { TProjectMetadata } from "@/project/types";

/**
 * Landing page for entering the editor from AI-Saturn.
 *
 * This lives on the editor's own origin, which is not the platform's — so the
 * token cannot come across in sessionStorage and has to ride on the query
 * string. This page is where it lands, and from here the navigation into
 * /editor/:id must stay *in this tab*: opening another window would hand the
 * editor an empty session and silently break transcription.
 *
 * Two ways in, matching the two ways the platform links out:
 *
 *   ?token=...&projectId=123   a project is already chosen — prefetch it and go
 *   ?token=...                 no project — let the user pick one of their drafts
 */

type PrepState =
	| { status: "idle" }
	| { status: "working"; label: string }
	| { status: "failed"; message: string };

// ---------------------------------------------------------------------------
// Explainer when the page is opened without the parameters the platform sends
// ---------------------------------------------------------------------------

function MissingParams() {
	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">从 AI-Saturn 进入剪辑</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				这个页面需要由 AI-Saturn 跳转进来，URL 上要带登录态：
			</p>
			<pre className="mt-4 overflow-x-auto rounded-md bg-muted p-4 text-xs">
				{`/saturn-open?token=Bearer%20xxx
/saturn-open?token=Bearer%20xxx&projectId=123&projectName=复仇之路`}
			</pre>
			<dl className="mt-4 space-y-1 text-sm text-muted-foreground">
				<div>
					<dt className="inline font-medium">token</dt>
					<dd className="inline"> —— AI-Saturn 的登录令牌（必填）</dd>
				</div>
				<div>
					<dt className="inline font-medium">projectId</dt>
					<dd className="inline">
						{" "}
						—— AI-Saturn 的项目 ID（不填则列出本地已有草稿）
					</dd>
				</div>
				<div>
					<dt className="inline font-medium">projectName</dt>
					<dd className="inline"> —— 可选，用于命名新建的草稿</dd>
				</div>
			</dl>
		</div>
	);
}

// ---------------------------------------------------------------------------
// No projectId — list the drafts already in this browser
// ---------------------------------------------------------------------------

function DraftPicker({
	prefetches,
	projects,
	onOpen,
}: {
	prefetches: SaturnShotPrefetch[];
	projects: TProjectMetadata[];
	onOpen: (projectId: string) => void;
}) {
	const byProjectId = new Map(projects.map((p) => [p.saturnProjectId, p]));

	if (prefetches.length === 0) {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<h1 className="text-xl font-semibold">选择要剪辑的项目</h1>
				<p className="mt-4 text-sm text-muted-foreground">
					这个浏览器里还没有从 AI-Saturn 打开过的项目。
					请在 AI-Saturn 中打开某个项目，从「剪辑」进入。
				</p>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">选择要剪辑的项目</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				这些项目已经预取过，打开即可使用。
			</p>
			<div className="mt-6 space-y-2">
				{prefetches.map((prefetch) => {
					const draft = byProjectId.get(prefetch.projectId);
					return (
						<button
							key={prefetch.projectId}
							type="button"
							onClick={() => draft && onOpen(draft.id)}
							className="flex w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
						>
							<span className="min-w-0">
								<span className="block truncate text-sm font-medium">
									{prefetch.projectName || `项目 ${prefetch.projectId}`}
								</span>
								<span className="mt-0.5 block text-xs text-muted-foreground">
									{prefetch.totalCount} 个镜头 · 预取于{" "}
									{new Date(prefetch.fetchedAt).toLocaleString()}
								</span>
							</span>
							<span className="ml-4 shrink-0 text-xs text-muted-foreground">
								{draft ? "打开" : "草稿已删除"}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Progress screen
// ---------------------------------------------------------------------------

function PrepScreen({ state, onRetry }: { state: PrepState; onRetry: () => void }) {
	if (state.status === "failed") {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<h1 className="text-xl font-semibold">无法进入剪辑</h1>
				<p className="mt-3 text-sm text-muted-foreground">{state.message}</p>
				<Button className="mt-6" onClick={onRetry}>
					重试
				</Button>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">正在准备剪辑项目</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				{state.status === "working" ? state.label : "正在准备…"}
			</p>
			<div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div className="h-full w-full animate-pulse rounded-full bg-primary opacity-40" />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function SaturnOpen() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const [state, setState] = useState<PrepState>({ status: "idle" });
	const [pickerData, setPickerData] = useState<{
		prefetches: SaturnShotPrefetch[];
		projects: TProjectMetadata[];
	} | null>(null);
	const hasStarted = useRef(false);

	const token = searchParams.get("token");
	const projectIdParam = searchParams.get("projectId");
	const projectId = projectIdParam ? Number(projectIdParam) : Number.NaN;
	const projectNameParam = searchParams.get("projectName");

	// The upstream site's branding, when it sent any. AI-Saturn serves several
	// brands off one codebase and tells them apart by Host, which this origin is
	// not — so the name and logo have to ride along with the link. Stored rather
	// than threaded through routing: the editor's chrome shows it on every page,
	// long after this one is gone.
	useEffect(() => {
		const brand = readBrandFromParams(searchParams);
		if (brand) saveBrand({ brand });
	}, [searchParams]);

	const openDraft = useCallback(
		(draftId: string) => {
			// Same tab on purpose — see the note at the top of this file.
			router.replace(`/editor/${draftId}`);
		},
		[router],
	);

	const prepare = useCallback(
		async (targetProjectId: number) => {
			if (!token) return;

			setState({ status: "working", label: "正在校验登录态…" });
			storeSaturnToken({ token });

			try {
				const shots = await fetchSaturnProjectShots({
					token,
					projectId: targetProjectId,
				});
				// Counted in segments, not nodes: a container shot and the sub-shots
				// inside it are one stretch of picture, and only one of the two
				// carries the render.
				const segments = projectShotSegments(shots);

				if (segments.length === 0) {
					throw new Error("该项目还没有分镜，请先在 AI-Saturn 生成分镜");
				}

				// Refused before creating anything. Nothing is placed on the
				// timeline, so a project with no renders would open onto an empty
				// assets panel and an empty timeline — and, being stamped as
				// complete, be reused on every later visit while the user waits
				// for footage that is never going to arrive. Far better to say so
				// here and let them come back when there is something to cut.
				const rendered = segments.filter(
					(shot) => typeof shot.videoUrl === "string" && shot.videoUrl.length > 0,
				);
				if (rendered.length === 0) {
					throw new Error(
						"该项目还没有生成好的成片，请先在 AI-Saturn 完成生成",
					);
				}

				const projectName =
					projectNameParam?.trim() || `AI-Saturn 项目 ${targetProjectId}`;

				saveShotPrefetch({
					projectId: targetProjectId,
					projectName,
					fetchedAt: new Date().toISOString(),
					shots,
					totalCount: rendered.length,
				});

				setState({ status: "working", label: "正在打开草稿…" });

				// Reuse the draft this project was last opened with rather than
				// creating a second one on every visit — the editor project holds
				// the user's actual timeline work.
				//
				// Only fully built drafts count. The project record is written
				// before the build finishes, so a failure in between leaves a real
				// project with no assets and no stamp; reusing that husk would
				// strand the user in it and never import their footage.
				//
				// The stamp, not duration: every save recomputes duration from the
				// live scenes, so a user who deleted all their clips would look
				// exactly like a project that was never built — and would silently
				// get a second draft forked off their work.
				// (`saturnLaidOut` keeps its name from when the build meant laying
				// out a timeline; it is now the "built, not a husk" flag.)
				const all = await storageService.loadAllProjectsMetadata();
				const existing = all
					.filter(
						(p) => p.saturnProjectId === targetProjectId && p.saturnLaidOut,
					)
					.sort(
						(a, b) =>
							new Date(b.updatedAt).getTime() -
							new Date(a.updatedAt).getTime(),
					)[0];

				if (existing) {
					openDraft(existing.id);
					return;
				}

				// No draft yet. Creation belongs to the editor (it needs a mounted
				// renderer and scenes to be usable), so park the intent with the
				// shots and let the editor's "project not found" path do it with
				// the platform's own project name.
				setShotHandoff({ saturnProjectId: targetProjectId, shots });
				markPendingOpen({ saturnProjectId: targetProjectId, projectName });

				setState({ status: "working", label: "正在创建草稿…" });
				openDraft(`new-${targetProjectId}`);
			} catch (error) {
				setState({
					status: "failed",
					message:
						error instanceof Error ? error.message : "准备剪辑项目失败",
				});
			}
		},
		[token, projectNameParam, openDraft],
	);

	// With a projectId the platform has already chosen for us — go straight in.
	useEffect(() => {
		if (!token || !Number.isFinite(projectId)) return;
		if (hasStarted.current) return;
		hasStarted.current = true;
		void prepare(projectId);
	}, [token, projectId, prepare]);

	// No projectId — surface the drafts this browser already has.
	useEffect(() => {
		if (!token || Number.isFinite(projectId)) return;
		if (hasStarted.current) return;
		hasStarted.current = true;

		void (async () => {
			const [prefetches, projects] = await Promise.all([
				Promise.resolve(listShotPrefetches()),
				storageService.loadAllProjectsMetadata().catch(() => []),
			]);
			setPickerData({ prefetches, projects });
		})();
	}, [token, projectId]);

	if (!token) {
		return <MissingParams />;
	}

	if (Number.isFinite(projectId)) {
		return (
			<PrepScreen
				state={state}
				onRetry={() => {
					hasStarted.current = false;
					setState({ status: "idle" });
					void prepare(projectId);
				}}
			/>
		);
	}

	if (!pickerData) {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<Skeleton className="h-14 w-full rounded-lg" />
				<Skeleton className="mt-2 h-14 w-full rounded-lg" />
			</div>
		);
	}

	return (
		<DraftPicker
			prefetches={pickerData.prefetches}
			projects={pickerData.projects}
			onOpen={openDraft}
		/>
	);
}

export default function SaturnOpenPage() {
	return (
		<Suspense fallback={null}>
			<SaturnOpen />
		</Suspense>
	);
}
