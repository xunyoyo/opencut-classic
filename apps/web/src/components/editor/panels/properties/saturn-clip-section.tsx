"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useEditor } from "@/editor/use-editor";
import { loadClipLinks, type SaturnClipLink } from "@/saturn/project-shots";
import { replaceClipWithVideo } from "@/saturn/replace-clip";
import type { TimelineElement } from "@/timeline";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

/**
 * "Download and replace" for a placeholder clip that came from AI-Saturn.
 *
 * Renders nothing for clips with no upstream link — a user who typed their own
 * text element should not see an action that cannot work for them. That check
 * is why this reads the link map rather than taking the shot as a prop: the
 * element knows nothing about AI-Saturn by design.
 */
export function SaturnClipSection({
	element,
}: {
	element: TimelineElement;
}) {
	const editor = useEditor();
	const [isWorking, setIsWorking] = useState(false);

	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	// Memoized: this reads localStorage, and the panel re-renders on every
	// playhead tick.
	const link: SaturnClipLink | undefined = useMemo(
		() => (projectId ? loadClipLinks({ projectId })[element.id] : undefined),
		[projectId, element.id],
	);

	const replace = useCallback(async () => {
		if (!projectId || !link) return;

		setIsWorking(true);
		try {
			const { durationSeconds } = await replaceClipWithVideo({
				editor,
				projectId,
				elementId: element.id,
				link,
			});
			toast.success(`已替换为视频（${durationSeconds.toFixed(2)}s）`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "替换失败");
		} finally {
			setIsWorking(false);
		}
	}, [editor, projectId, link, element.id]);

	if (!link) return null;

	return (
		<Section sectionKey={`${element.id}:saturn`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{link.videoUrl ? (
						<>
							<Button
								onClick={() => void replace()}
								disabled={isWorking}
								className="w-full"
							>
								{isWorking && (
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
								)}
								{isWorking ? "正在下载…" : "下载并替换为视频"}
							</Button>
							<p className="text-muted-foreground text-xs leading-relaxed">
								替换后时长以视频实际长度为准，后面的片段会跟着顺移。
							</p>
						</>
					) : (
						<p className="text-muted-foreground text-xs leading-relaxed">
							这个镜头还没有生成好的视频。请在 AI-Saturn 里生成后再回来。
						</p>
					)}
					{link.shotNo && (
						<p className="text-muted-foreground text-xs">
							对应分镜：镜{link.shotNo}
						</p>
					)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
