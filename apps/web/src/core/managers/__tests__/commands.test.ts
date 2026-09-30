import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BatchCommand } from "@/commands/batch-command";
import { Command, type CommandResult } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import { CommandManager } from "@/core/managers/commands";

/** Records when it is disposed; does nothing else. */
class RecordingCommand extends Command {
	disposals = 0;
	private readonly name: string;
	private readonly log: string[];

	constructor({ name, log }: { name: string; log: string[] }) {
		super();
		this.name = name;
		this.log = log;
	}

	execute(): CommandResult | undefined {
		return undefined;
	}

	undo(): void {}

	dispose(): void {
		this.disposals += 1;
		this.log.push(this.name);
	}
}

/** `CommandManager` only reads selection snapshots off the editor here. */
function createManager() {
	const editor = {
		selection: {
			getSnapshot: () => ({}),
			restoreSnapshot: () => {},
		},
	} as unknown as EditorCore;
	const disposed: string[] = [];
	const manager = new CommandManager(editor);
	const run = (name: string) => {
		const command = new RecordingCommand({ name, log: disposed });
		manager.execute({ command });
		return command;
	};
	return { manager, disposed, run };
}

afterEach(() => {
	mock.restore();
});

describe("CommandManager disposal", () => {
	test("disposes exactly the entries trimmed off the bottom of the history", () => {
		const { disposed, run } = createManager();

		for (let i = 0; i < 100; i += 1) run(`c${i}`);
		expect(disposed).toEqual([]);

		run("c100");
		run("c101");

		expect(disposed).toEqual(["c0", "c1"]);
	});

	test("disposes the redo stack when a new command replaces it", () => {
		const { manager, disposed, run } = createManager();
		run("a");
		run("b");
		manager.undo();
		manager.undo();
		expect(disposed).toEqual([]);

		run("c");

		expect(disposed.sort()).toEqual(["a", "b"]);
	});

	test("does not dispose commands that only move between undo and redo", () => {
		const { manager, disposed, run } = createManager();
		run("a");

		manager.undo();
		manager.redo();
		manager.undo();

		expect(disposed).toEqual([]);
	});

	test("disposes everything once when the history is cleared", () => {
		const { manager, disposed, run } = createManager();
		const a = run("a");
		const b = run("b");
		manager.undo();

		manager.clear();
		manager.clear();

		expect(disposed.sort()).toEqual(["a", "b"]);
		expect(a.disposals).toBe(1);
		expect(b.disposals).toBe(1);
	});

	test("a batch passes disposal on to every command in it", () => {
		const { manager, disposed } = createManager();
		manager.execute({
			command: new BatchCommand([
				new RecordingCommand({ name: "first", log: disposed }),
				new RecordingCommand({ name: "second", log: disposed }),
			]),
		});

		manager.clear();

		expect(disposed).toEqual(["first", "second"]);
	});

	test("a failing disposal is logged and does not undo the operation", () => {
		const { manager, run } = createManager();
		const error = spyOn(console, "error").mockImplementation(() => {});
		const failing = run("failing");
		failing.dispose = () => {
			throw new Error("boom");
		};
		manager.undo();

		run("next");

		expect(manager.canUndo()).toBe(true);
		expect(manager.canRedo()).toBe(false);
		expect(error).toHaveBeenCalled();
	});
});
