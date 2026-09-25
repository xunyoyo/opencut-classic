/**
 * An in-memory stand-in for `IndexedDBAdapter`.
 *
 * `bun test` has no `indexedDB`, and the project has no `fake-indexeddb` to
 * borrow, so the adapter itself is replaced rather than the database behind it.
 * That is the better seam anyway: what these tests exercise is the store's own
 * logic — zod parsing, the project-key filter, pruning order — none of which
 * lives in the adapter, and all of which a real IndexedDB would helpfully hide.
 *
 * Adapters are keyed by `dbName` so two adapters opened over the same database
 * in one test share entries, the way IndexedDB would.
 */

/**
 * `unknown` at rest, not `T`.
 *
 * A real adapter hands back whatever was serialized, without inspecting it —
 * validating the shape is the *store's* job, via zod, and that validation is
 * precisely what these tests exist to check. Storing `T` here would make the
 * mock assert a shape the real adapter never guarantees, and would need a cast
 * in both directions to keep up the pretence.
 */
export const adapterStore = new Map<string, Map<string, unknown>>();

export function resetAdapterStore(): void {
	adapterStore.clear();
}

export function createMockIndexedDBAdapterClass() {
	return class MockIndexedDBAdapter<T> {
		private dbName: string;

		constructor({
			dbName,
		}: {
			dbName: string;
			storeName: string;
			version?: number;
		}) {
			this.dbName = dbName;
			if (!adapterStore.has(dbName)) {
				adapterStore.set(dbName, new Map());
			}
		}

		private get map(): Map<string, unknown> {
			const map = adapterStore.get(this.dbName);
			if (!map) throw new Error(`no mock database for ${this.dbName}`);
			return map;
		}

		async get(key: string): Promise<T | null> {
			const value = this.map.get(key);
			if (value === undefined) return null;
			// Widened to `T` at the boundary, mirroring the real adapter: it
			// returns a deserialized object and never checks its shape. The
			// store then validates with zod.
			return asStoredType<T>({ value });
		}

		async set({ key, value }: { key: string; value: T }): Promise<void> {
			this.map.set(key, value);
		}

		async remove(key: string): Promise<void> {
			this.map.delete(key);
		}

		async list(): Promise<string[]> {
			return [...this.map.keys()];
		}

		async getAll(): Promise<T[]> {
			const values: T[] = [];
			for (const value of this.map.values()) {
				values.push(asStoredType<T>({ value }));
			}
			return values;
		}

		async clear(): Promise<void> {
			this.map.clear();
		}
	};
}

/**
 * The single widening in this file, in one place so it is visible rather than
 * sprinkled through the methods above.
 *
 * There is no runtime check that can make this true — the whole point of the
 * mock is to hand back unvalidated data so the store's zod schema is what
 * decides whether it is usable. Narrowing here would defeat the tests.
 */
function asStoredType<T>({ value }: { value: unknown }): T {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- deliberate: unvalidated data is the input under test, see above
	return value as T;
}
