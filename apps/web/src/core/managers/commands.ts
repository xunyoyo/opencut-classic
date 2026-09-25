import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

/**
 * Depth cap on the undo stack.
 *
 * Every entry pins a command that holds a full `savedState` tracks snapshot plus
 * a selection snapshot, so an unbounded stack grows without limit over a long
 * editing session — the retained track trees dominate the editor's memory. The
 * cap is deliberately far larger than any realistic "I need to go further back"
 * reach, so trimming is invisible to users while keeping the ceiling bounded.
 *
 * Entries are dropped from the *front*: undo has to replay the most recent
 * commands first, so the stale entries are the ones at the bottom of the stack.
 */
const MAX_HISTORY_DEPTH = 100;

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.pushHistoryEntry({
			entry: {
				command,
				previousSelection,
				selectionOverride,
			},
		});
		this.redoStack = [];
		this.notify();
		return command;
	}

	push({ command }: { command: Command }): void {
		this.pushHistoryEntry({
			entry: {
				command,
				previousSelection: this.getSelectionSnapshot(),
			},
		});
		this.redoStack = [];
		this.notify();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
		}
		this.notify();
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.pushHistoryEntry({
			entry: {
				command: entry.command,
				previousSelection,
				selectionOverride,
			},
		});
		this.notify();
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	/**
	 * Drops the whole history. Callers must invoke this whenever the active
	 * project changes: entries hold element/track ids that only mean something
	 * inside the timeline they were recorded against, so keeping them across a
	 * project switch lets an undo write the previous project's ids into the new
	 * project's tracks.
	 */
	clear(): void {
		const hadEntries = this.history.length > 0 || this.redoStack.length > 0;
		this.history = [];
		this.redoStack = [];
		// Only wake subscribers on an actual change — callers clear defensively
		// (including for projects that never recorded anything), and notifying
		// unconditionally would re-render every editor subscriber on each load.
		if (hadEntries) {
			this.notify();
		}
	}

	private pushHistoryEntry({ entry }: { entry: CommandHistoryEntry }): void {
		this.history.push(entry);
		if (this.history.length > MAX_HISTORY_DEPTH) {
			this.history.splice(0, this.history.length - MAX_HISTORY_DEPTH);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
