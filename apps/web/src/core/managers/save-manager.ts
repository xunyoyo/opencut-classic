import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	/**
	 * The write currently in flight, or null. Tracked so `flush` can wait for
	 * it instead of colliding with `saveNow`'s `isSaving` early return — see
	 * the comment there.
	 */
	private savePromise: Promise<void> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.queueSave();
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;

		// A save already in flight cannot be joined by re-entering `saveNow` —
		// it returns early on `isSaving`, which would hand the caller a "flushed"
		// that never happened and leave the newest edits waiting on a debounce
		// timer that the caller is about to make unmountable. Waiting the write
		// out and then saving again is what makes this a flush rather than a
		// nudge: the exit path depends on it, and `closeProject` clears the
		// scenes immediately afterwards.
		await this.savePromise;
		await this.saveNow();
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	private queueSave(): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			void this.saveNow();
		}, this.debounceMs);
	}

	private async saveNow(): Promise<void> {
		if (this.isSaving) return;
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();

		const write = (async () => {
			try {
				await this.editor.project.saveCurrentProject();
			} finally {
				this.isSaving = false;
				if (this.hasPendingSave) {
					this.queueSave();
				}
			}
		})();
		this.savePromise = write;

		try {
			await write;
		} finally {
			// Identity-checked rather than cleared outright: the `finally` above
			// can queue a re-entrant save that has already replaced the slot, and
			// nulling it here would disown that write — leaving `flush` awaiting a
			// resolved promise while a real one was still running.
			if (this.savePromise === write) {
				this.savePromise = null;
			}
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
