import type { StorageAdapter } from "./types";

/**
 * How long an `open`/`delete` may sit unsettled before it is treated as blocked.
 *
 * Both calls take an exclusive lock on the database, and neither fails when
 * another tab already holds a connection to it: the request fires `blocked` and
 * then simply never settles. That is a silent, permanent hang — the editor
 * shows its loading spinner forever with nothing in the console, because the
 * await it is stuck on has no other exit.
 *
 * There is no event that tells us the blocking tab went away, so a deadline is
 * the only way to turn the hang into a reportable error. Ten seconds is far
 * longer than a healthy open (single-digit milliseconds) and short enough that
 * a user who has another editor tab open gets told rather than waiting.
 */
const OPEN_TIMEOUT_MS = 10_000;

/**
 * Adapts a settlement callback to the `Event` handler signature the IDB request
 * uses. `resolve`/`reject` take the *result*, but a handler is passed the event,
 * so handing one over directly would type as "the event is the result" — true at
 * runtime for `onsuccess`, wrong for every reader.
 */
function onEvent(callback: () => void): (event: Event) => void {
	return () => callback();
}

/**
 * Fails a request that has gone silent, and treats `blocked` as a failure.
 *
 * `blocked` is the event the docs name for "another connection has this database
 * open": it fires instead of success/error and nothing follows it, so it is
 * settled here rather than left for the timer. The timer stays as the backstop
 * for the cases that report nothing at all.
 *
 * Only `open` and `delete` take the exclusive lock, so this stays separate from
 * the per-store requests rather than being folded into all of them.
 */
function withBlockedTimeout({
	request,
	describe,
}: {
	request: IDBOpenDBRequest;
	describe: string;
}): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(blockedMessage({ describe, timedOut: true }))),
			OPEN_TIMEOUT_MS,
		);

		request.onblocked = onEvent(() => {
			clearTimeout(timer);
			reject(new Error(blockedMessage({ describe, timedOut: false })));
		});
		request.onsuccess = onEvent(() => {
			clearTimeout(timer);
			const result = request.result;
			// Unreachable for an `open` request — a success carries the
			// connection. Checked rather than asserted (this codebase rejects
			// narrowing assertions) so the shared helper can also serve a
			// `delete`, whose success carries nothing.
			if (!result) {
				reject(new Error(`${describe} succeeded without a database`));
				return;
			}
			resolve(result);
		});
		request.onerror = onEvent(() => {
			clearTimeout(timer);
			reject(request.error);
		});
	});
}

/**
 * The same deadline for `deleteDatabase`, which is equally blockable — and is
 * worse placed: it runs as the one-time cleanup at the top of
 * `runStorageMigrations`, before any store is read, so a delete held open by
 * another tab's connection stops a project load before it starts.
 */
function withBlockedDelete({
	request,
	describe,
}: {
	request: IDBOpenDBRequest;
	describe: string;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(blockedMessage({ describe, timedOut: true }))),
			OPEN_TIMEOUT_MS,
		);

		request.onblocked = onEvent(() => {
			clearTimeout(timer);
			reject(new Error(blockedMessage({ describe, timedOut: false })));
		});
		request.onsuccess = onEvent(() => {
			clearTimeout(timer);
			resolve();
		});
		request.onerror = onEvent(() => {
			clearTimeout(timer);
			reject(request.error);
		});
	});
}

function blockedMessage({
	describe,
	timedOut,
}: {
	describe: string;
	timedOut: boolean;
}): string {
	const why = timedOut
		? `did not respond within ${OPEN_TIMEOUT_MS}ms`
		: "was blocked";
	return `${describe} ${why} — another tab is holding this database open. Close other editor tabs and reload.`;
}

export class IndexedDBAdapter<T> implements StorageAdapter<T> {
	private dbName: string;
	private storeName: string;
	private version: number;

	constructor({
		dbName,
		storeName,
		version = 1,
	}: {
		dbName: string;
		storeName: string;
		version?: number;
	}) {
		this.dbName = dbName;
		this.storeName = storeName;
		this.version = version;
	}

	private async getDB(): Promise<IDBDatabase> {
		const request = indexedDB.open(this.dbName, this.version);

		request.onupgradeneeded = (event) => {
			const db = (event.target as IDBOpenDBRequest).result;
			if (!db.objectStoreNames.contains(this.storeName)) {
				db.createObjectStore(this.storeName, { keyPath: "id" });
			}
		};

		const db = await withBlockedTimeout({
			request,
			describe: `Opening "${this.dbName}"`,
		});

		return db;
	}

	async get(key: string): Promise<T | null> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readonly");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.get(key);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result || null);
		});
	}

	async set({
		key,
		value,
	}: {
		key: string;
		value: T;
	}): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.put({ id: key, ...value });
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async remove(key: string): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.delete(key);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}

	async list(): Promise<string[]> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readonly");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.getAllKeys();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result as string[]);
		});
	}

	async getAll(): Promise<T[]> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readonly");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result || []);
		});
	}

	async clear(): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction([this.storeName], "readwrite");
		const store = transaction.objectStore(this.storeName);

		return new Promise((resolve, reject) => {
			const request = store.clear();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve();
		});
	}
}

export async function deleteDatabase({
	dbName,
}: {
	dbName: string;
}): Promise<void> {
	await withBlockedDelete({
		request: indexedDB.deleteDatabase(dbName),
		describe: `Deleting "${dbName}"`,
	});
}
