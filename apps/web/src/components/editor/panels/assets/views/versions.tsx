"use client";

import { useCallback, useEffect, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEditor } from "@/editor/use-editor";
import { cn } from "@/utils/ui";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Clock01Icon,
	RefreshIcon,
	FloppyDiskIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import {
	getUnrecoverableReason,
	type ProjectVersionSummary,
} from "@/versions/types";

/**
 * Three states, kept apart on purpose.
 *
 * "Failed to read" and "you have no versions" look identical on screen and
 * mean opposite things — telling a user their saved work is gone because an
 * IndexedDB request wedged is the worse of the two errors. Read failures get
 * their own card with a retry; only a successful empty read says "none".
 */
type ListState =
	| { status: "loading" }
	| { status: "failed"; reason: string }
	| { status: "ready"; versions: ProjectVersionSummary[] };

export function VersionsView() {
	const editor = useEditor();
	const [state, setState] = useState<ListState>({ status: "loading" });
	const [isSaving, setIsSaving] = useState(false);
	const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
	const [versionName, setVersionName] = useState("");
	const [applyingId, setApplyingId] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] =
		useState<ProjectVersionSummary | null>(null);

	/**
	 * Loads the list without first dropping to the skeleton.
	 *
	 * Used by the mount effect, which already starts in `loading` (set by
	 * `useState`), so re-setting it would only cause a second render. State is
	 * assigned after the `await`, never synchronously in the effect body — that
	 * is what the lint rule against cascading renders is asking for, rather
	 * than something to suppress.
	 */
	const load = useCallback(async () => {
		const result = await editor.versions.list();
		if (!result.ok) {
			setState({ status: "failed", reason: result.reason });
			return;
		}
		setState({ status: "ready", versions: result.versions });
	}, [editor]);

	/** Refresh drops back to the skeleton first, since data is on screen. */
	const refresh = useCallback(async () => {
		setState({ status: "loading" });
		await load();
	}, [load]);

	useEffect(() => {
		let shouldIgnore = false;

		// `load` has no cancellation of its own, so the guard is applied around
		// it: a panel unmounted mid-request must not write state afterwards.
		const loadOnce = async () => {
			if (shouldIgnore) return;
			await load();
		};

		void loadOnce();

		return () => {
			shouldIgnore = true;
		};
	}, [load]);

	const handleSave = async ({ name }: { name: string }) => {
		if (isSaving) return;
		setIsSaving(true);
		try {
			// A blank name is stored blank, not filled in with a formatted date:
			// the row renders the timestamp itself, so an auto-named version and
			// a hand-named one stay distinguishable.
			const saved = await editor.versions.save({ name: name.trim() });
			if (!saved) {
				toast.error("保存版本失败", { description: "没有打开的项目" });
				return;
			}
			setIsSaveDialogOpen(false);
			setVersionName("");
			toast.success("已保存版本");
			await refresh();
		} catch (error) {
			toast.error("保存版本失败", {
				description: error instanceof Error ? error.message : "请重试",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleApply = async (version: ProjectVersionSummary) => {
		// In-flight guard: a double click would snapshot twice and restore
		// twice, and the second restore's auto-snapshot would capture the
		// already-restored state — silently losing the pre-restore work the
		// first snapshot was taken to protect.
		if (applyingId) return;
		setApplyingId(version.id);
		try {
			const result = await editor.versions.apply({ versionId: version.id });
			if (!result.ok) {
				toast.error("恢复版本失败", { description: result.reason });
				return;
			}
			toast.success("已恢复到该版本", {
				description: "当前状态已自动另存为一个版本。",
			});
			for (const warning of result.warnings) {
				toast.warning("请注意", { description: warning });
			}
			await refresh();
		} catch (error) {
			toast.error("恢复版本失败", {
				description: error instanceof Error ? error.message : "请重试",
			});
		} finally {
			setApplyingId(null);
		}
	};

	const handleDelete = async (version: ProjectVersionSummary) => {
		try {
			await editor.versions.remove({ versionId: version.id });
			toast.success("已删除版本");
			setPendingDelete(null);
			await refresh();
		} catch (error) {
			toast.error("删除版本失败", {
				description: error instanceof Error ? error.message : "请重试",
			});
		}
	};

	return (
		<>
			<PanelView
				title="版本记录"
				actions={
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="刷新"
							onClick={() => void refresh()}
						>
							<HugeiconsIcon icon={RefreshIcon} className="size-4" />
						</Button>
						<Button
							variant="secondary"
							size="sm"
							className="h-7 gap-1 px-2 text-xs"
							disabled={isSaving}
							onClick={() => setIsSaveDialogOpen(true)}
						>
							<HugeiconsIcon icon={FloppyDiskIcon} className="size-3.5" />
							保存版本
						</Button>
					</div>
				}
			>
				{state.status === "loading" && <LoadingRows />}
				{state.status === "failed" && (
					<ReadFailedCard
						reason={state.reason}
						onRetry={() => void refresh()}
					/>
				)}
				{state.status === "ready" && state.versions.length === 0 && (
					<NoVersionsCard />
				)}
				{state.status === "ready" && state.versions.length > 0 && (
					<div className="flex flex-col gap-1 pb-2">
						{state.versions.map((version) => (
							<VersionRow
								key={version.id}
								version={version}
								currentAppVersion={editor.versions.currentAppVersion()}
								isApplying={applyingId === version.id}
								isAnyApplying={applyingId !== null}
								onApply={() => void handleApply(version)}
								onDelete={() => setPendingDelete(version)}
							/>
						))}
					</div>
				)}
			</PanelView>

			<SaveVersionDialog
				isOpen={isSaveDialogOpen}
				isSaving={isSaving}
				versionName={versionName}
				onNameChange={setVersionName}
				onOpenChange={setIsSaveDialogOpen}
				onConfirm={() => void handleSave({ name: versionName })}
			/>

			<Dialog
				open={pendingDelete !== null}
				onOpenChange={(isOpen) => !isOpen && setPendingDelete(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除这个版本？</DialogTitle>
						<DialogDescription>
							删除后无法恢复。其他版本和工程本身不受影响。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button
							variant="destructive"
							onClick={() => {
								if (pendingDelete) void handleDelete(pendingDelete);
							}}
						>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function VersionRow({
	version,
	currentAppVersion,
	isApplying,
	isAnyApplying,
	onApply,
	onDelete,
}: {
	version: ProjectVersionSummary;
	currentAppVersion: number;
	isApplying: boolean;
	isAnyApplying: boolean;
	onApply: () => void;
	onDelete: () => void;
}) {
	// Kept as a labelled, disabled row rather than hidden. A version the user
	// cannot restore is still a version they made, and removing it from the
	// list reads as "my save is gone".
	const unrecoverable = getUnrecoverableReason({
		version,
		currentAppVersion,
	});

	return (
		<div
			className={cn(
				"group flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 transition-colors",
				version.isCurrent && "border-primary/40 bg-primary/5",
			)}
		>
			<div className="min-w-0 flex flex-col gap-0.5">
				<span className="truncate text-sm">
					{version.name || formatTimestamp({ createdAt: version.createdAt })}
				</span>
				<span className="text-muted-foreground flex items-center gap-1 text-xs">
					{version.name ? (
						<>
							<HugeiconsIcon icon={Clock01Icon} className="size-3" />
							{formatTimestamp({ createdAt: version.createdAt })}
						</>
					) : null}
					{version.isAuto ? <span>· 自动保存</span> : null}
					{version.mediaCount > 0 ? (
						<span>· {version.mediaCount} 个素材</span>
					) : null}
				</span>
			</div>

			<div className="flex shrink-0 items-center gap-1">
				{version.isCurrent ? (
					<Badge variant="secondary" className="text-xs">
						当前版本
					</Badge>
				) : unrecoverable ? (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								{/* A disabled button swallows pointer events, so the
								    tooltip would never fire; the wrapper keeps the
								    explanation reachable. */}
								<span className="cursor-not-allowed">
									<Button
										variant="outline"
										size="sm"
										className="h-7 text-xs"
										disabled
									>
										应用版本
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent side="left">{unrecoverable}</TooltipContent>
						</Tooltip>
					</TooltipProvider>
				) : (
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						disabled={isAnyApplying}
						onClick={onApply}
					>
						{isApplying ? "恢复中…" : "应用版本"}
					</Button>
				)}
				<Button
					variant="ghost"
					size="icon"
					className="text-muted-foreground size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
					aria-label="删除该版本"
					onClick={onDelete}
				>
					<HugeiconsIcon icon={Delete02Icon} className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}

function formatTimestamp({ createdAt }: { createdAt: number }): string {
	return new Date(createdAt).toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function LoadingRows() {
	return (
		<div className="flex flex-col gap-1 pb-2">
			{Array.from({ length: 4 }).map((_, index) => (
				<Skeleton key={index} className="h-12 w-full rounded-md" />
			))}
		</div>
	);
}

function ReadFailedCard({
	reason,
	onRetry,
}: {
	reason: string;
	onRetry: () => void;
}) {
	return (
		<div className="border-destructive/40 bg-destructive/5 mt-2 flex flex-col gap-3 rounded-md border p-3">
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium">没能读取到本地的版本记录</p>
				<p className="text-muted-foreground text-xs text-balance">
					这不代表版本真的不见了 —— 只是这次读取失败了。请刷新重试，
					不要重新保存覆盖当前状态。
				</p>
				<p className="text-muted-foreground/80 text-xs">{reason}</p>
			</div>
			<Button variant="outline" size="sm" className="w-fit" onClick={onRetry}>
				重试
			</Button>
		</div>
	);
}

function NoVersionsCard() {
	return (
		<div className="flex flex-col items-center justify-center gap-2 px-4 py-16 text-center">
			<HugeiconsIcon
				icon={Clock01Icon}
				className="text-muted-foreground/75 size-10"
				strokeWidth={1}
			/>
			<p className="text-sm font-medium">还没有保存过版本</p>
			<p className="text-muted-foreground text-xs text-balance">
				保存一个版本，之后可以随时回到这个状态。
				恢复旧版本时，当前状态会自动另存为一个新版本。
			</p>
		</div>
	);
}

function SaveVersionDialog({
	isOpen,
	isSaving,
	versionName,
	onNameChange,
	onOpenChange,
	onConfirm,
}: {
	isOpen: boolean;
	isSaving: boolean;
	versionName: string;
	onNameChange: (name: string) => void;
	onOpenChange: (isOpen: boolean) => void;
	onConfirm: () => void;
}) {
	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>保存版本</DialogTitle>
					<DialogDescription>
						保存当前剪辑为一个版本。留空则按时间自动命名。
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-3">
					<Label>版本名称（可选）</Label>
					<Input
						value={versionName}
						onChange={(event) => onNameChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								onConfirm();
							}
						}}
						placeholder="例如：第一版粗剪"
					/>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={isSaving}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onOpenChange(false);
						}}
					>
						取消
					</Button>
					<Button disabled={isSaving} onClick={onConfirm}>
						{isSaving ? "保存中…" : "保存"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
