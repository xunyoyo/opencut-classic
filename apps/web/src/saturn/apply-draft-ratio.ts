import { storageService } from "@/services/storage/service";
import {
	planDraftRatioUpdate,
	type ParsedCustomRatio,
} from "./custom-ratio";

/**
 * Brings an existing local draft in line with the ratio AI-Saturn opened it
 * with (see `planDraftRatioUpdate` for the rules).
 *
 * Done on the stored record, before navigating into the editor, so the editor
 * simply loads a draft that already has the right canvas — no second code path
 * inside the editor needs to know about it. Returns whether anything changed.
 * Never throws: failing to adjust the canvas must not stop the user from
 * opening their own draft.
 */
export async function applyRatioToDraft({
	draftId,
	parsed,
	custom,
}: {
	draftId: string;
	parsed: ParsedCustomRatio | null;
	custom: boolean;
}): Promise<boolean> {
	if (!parsed) return false;

	try {
		const loaded = await storageService.loadProject({ id: draftId });
		if (!loaded) return false;

		const patch = planDraftRatioUpdate({
			settings: loaded.project.settings,
			parsed,
			custom,
		});
		if (!patch) return false;

		await storageService.saveProject({
			project: {
				...loaded.project,
				settings: { ...loaded.project.settings, ...patch },
				metadata: { ...loaded.project.metadata, updatedAt: new Date() },
			},
		});
		return true;
	} catch (error) {
		console.warn("[saturn-open] could not apply ratio to draft", error);
		return false;
	}
}
