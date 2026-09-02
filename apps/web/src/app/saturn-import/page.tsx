"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useEditor } from "@/editor/use-editor";
import { storeSaturnToken } from "@/saturn/session";
import {
	importSaturnView,
	type ImportProgress,
} from "@/saturn/import";

type ImportState =
	| { status: "idle" }
	| { status: "running"; progress: ImportProgress }
	| { status: "failed"; message: string };

function MissingParams() {
	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">从 AI-Saturn 导入</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				这个页面需要由 AI-Saturn 跳转进来，URL 上要带场次和登录态：
			</p>
			<pre className="mt-4 overflow-x-auto rounded-md bg-muted p-4 text-xs">
				/saturn-import?viewId=123&amp;type=1&amp;token=Bearer%20xxx
			</pre>
			<dl className="mt-4 space-y-1 text-sm text-muted-foreground">
				<div>
					<dt className="inline font-medium">viewId</dt>
					<dd className="inline"> —— AI-Saturn 的场次 ID</dd>
				</div>
				<div>
					<dt className="inline font-medium">type</dt>
					<dd className="inline"> —— 1 九宫格分镜，2 故事板分镜</dd>
				</div>
				<div>
					<dt className="inline font-medium">token</dt>
					<dd className="inline"> —— AI-Saturn 的登录令牌</dd>
				</div>
				<div>
					<dt className="inline font-medium">name</dt>
					<dd className="inline"> —— 可选，项目名</dd>
				</div>
			</dl>
		</div>
	);
}

function SaturnImport() {
	const editor = useEditor();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [state, setState] = useState<ImportState>({ status: "idle" });

	const viewIdParam = searchParams.get("viewId");
	const viewId = viewIdParam ? Number(viewIdParam) : Number.NaN;
	const type = Number(searchParams.get("type") ?? "1");
	const token = searchParams.get("token");
	const projectName =
		searchParams.get("name") ?? `AI-Saturn 场次 ${viewIdParam ?? ""}`.trim();
	// Captions are the point of handing a cut to OpenCut, so this defaults on;
	// `captions=0` is the escape hatch for when the model download isn't wanted.
	const autoCaption = searchParams.get("captions") !== "0";

	// React 18 StrictMode mounts effects twice in development. Without this the
	// import would run twice and leave a stray duplicate project behind.
	const hasStarted = useRef(false);

	const runImport = useCallback(async () => {
		if (!token || !Number.isFinite(viewId)) return;

		// Keep the token for the rest of the tab. Transcription runs later, from
		// the editor, and by then this URL is gone.
		storeSaturnToken({ token });

		setState({
			status: "running",
			progress: { label: "正在准备…", ratio: null },
		});

		try {
			const result = await importSaturnView({
				editor,
				viewId,
				type,
				token,
				projectName,
				onProgress: ({ progress }) => {
					setState({ status: "running", progress });
				},
			});

			// Set before navigating: the editor reads this as it mounts the
			// Captions view, which is what makes transcription start on its own.
			if (autoCaption) {
				useAssetsPanelStore.getState().requestAutoCaption();
			}

			router.replace(`/editor/${result.projectId}`);
		} catch (error) {
			setState({
				status: "failed",
				message:
					error instanceof Error ? error.message : "导入失败，请稍后重试",
			});
		}
	}, [editor, router, viewId, type, token, projectName, autoCaption]);

	useEffect(() => {
		if (hasStarted.current) return;
		hasStarted.current = true;
		void runImport();
	}, [runImport]);

	if (!token || !Number.isFinite(viewId)) {
		return <MissingParams />;
	}

	if (state.status === "failed") {
		return (
			<div className="mx-auto max-w-lg px-6 py-16">
				<h1 className="text-xl font-semibold">导入失败</h1>
				<p className="mt-3 text-sm text-muted-foreground">{state.message}</p>
				<Button
					className="mt-6"
					onClick={() => {
						void runImport();
					}}
				>
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

export default function SaturnImportPage() {
	return (
		<Suspense fallback={null}>
			<SaturnImport />
		</Suspense>
	);
}
