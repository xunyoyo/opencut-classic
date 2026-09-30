import type { EditorSelectionPatch } from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

export interface CommandResult {
	selection?: EditorSelectionPatch;
}

export function createElementSelectionResult(
	selectedElements: ElementRef[],
): CommandResult {
	return {
		selection: {
			selectedElements,
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		},
	};
}

export abstract class Command {
	abstract execute(): CommandResult | undefined;

	undo(): void {
		throw new Error("Undo not implemented for this command");
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}

	/**
	 * Called once the command has left the history for good — trimmed off the
	 * bottom of the undo stack, dropped with the redo stack, or cleared with
	 * the whole history — and so will never be undone or redone again. A
	 * command that keeps something alive only for the sake of undo or redo
	 * lets go of it here. Called at most once.
	 */
	dispose(): void {
		// Most commands hold nothing beyond their own snapshots.
	}
}
