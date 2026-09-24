/**
 * Deadline for the browser's own calls into `/api/saturn/*`.
 *
 * The server-side routes now bound their leg of the trip (see
 * `app/api/saturn/upstream-timeout.ts`), but that protects the wrong segment
 * on its own: a request that never gets a response — a wedged connection, a
 * server that accepted the socket and stopped, a route that itself awaits
 * something unbounded — still leaves the caller's `await` pending, and these
 * callers gate the whole page on it. `prepare()` in `saturn-open/page.tsx` sets
 * a `working` state, awaits one of these, and has no way out if it never
 * settles: the spinner it shows is a pure CSS pulse, so a dead request and a
 * slow one look identical, and the retry button only exists on the `failed`
 * path that is never reached.
 *
 * Slightly longer than the server's own 15s upstream deadline so the server's
 * error — which is specific, and comes with a status code — is normally what
 * the user ends up seeing. This one is the backstop for when even that does
 * not arrive.
 */
export const CLIENT_FETCH_TIMEOUT_MS = 20_000;

/**
 * A deadline signal for a client-side request, or the caller's own signal when
 * they supplied one.
 *
 * Honouring a passed-in signal rather than always making a fresh one keeps the
 * abort semantics the callers already expect: a caller who aborts on unmount
 * should still cut the request short, and `AbortSignal.timeout` alone would
 * ignore that and hold the socket open until the deadline.
 */
export function clientFetchSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * True when a caught error is a deadline firing rather than a real network
 * failure.
 *
 * Both `AbortSignal.timeout` and `AbortSignal.any` reject with `TimeoutError`
 * (a `DOMException`), while an abort by hand rejects with `AbortError`. Neither
 * is a `TypeError`, which is what a genuine connection failure looks like, so
 * the three cases stay distinguishable and can be told apart in the message
 * the user is shown.
 */
export function isFetchTimeout(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}

/**
 * Races `work` against a deadline, rejecting with a readable message if the
 * deadline arrives first.
 *
 * For waits that are not `fetch` and so cannot take a signal — reading the
 * project list out of IndexedDB, most importantly. `getDB()` bounds *opening*
 * the database, but the store requests that follow (`getAll` and friends) carry
 * only an `onerror` handler, and a request the browser never answers fires
 * neither `success` nor `error`: it simply never settles. A `.catch()` around
 * such a call handles rejection and cannot handle that, which is how the
 * draft picker ends up on its skeleton screen with no failure card and no
 * retry — see the note in `saturn-open/page.tsx`.
 *
 * The timer is cleared when `work` wins, so a resolved call does not leave a
 * pending rejection behind.
 */
export function withDeadline<T>({
	work,
	message,
	ms = CLIENT_FETCH_TIMEOUT_MS,
}: {
	work: Promise<T>;
	message: string;
	ms?: number;
}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
