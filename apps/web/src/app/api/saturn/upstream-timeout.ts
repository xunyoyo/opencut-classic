/**
 * Deadline for every call we make to the AI-Saturn backend.
 *
 * Without one, an upstream that accepts the connection and then never answers
 * leaves our own `await` pending forever — and since the callers of these
 * routes are pages that gate their whole UI on the response, "forever" is what
 * the user sees: a spinner with no failure card and nothing to retry.
 *
 * `/api/saturn/session` has carried this guard since it was written, precisely
 * because its route is the one the user is staring at while it runs. The other
 * routes proxy the same upstream and were missing it, so the same stall could
 * happen one request later.
 *
 * 15s is chosen against the upstream's own behaviour: every route here is a
 * single row read (a list, a points balance, a shot tree), and the heaviest of
 * them answers in milliseconds when healthy. Anything slower than this is a
 * stall rather than a slow query, so failing fast is strictly better than
 * holding the user on a spinner.
 */
export const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Builds the abort signal for an upstream request.
 *
 * Returned as a fresh signal per call rather than a shared constant: a single
 * `AbortSignal` carries one deadline from the moment it is created, so reusing
 * one across requests would give later requests a shorter and shorter window.
 */
export function upstreamSignal(): AbortSignal {
	return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

/**
 * True when a caught error is this module's deadline firing, as opposed to the
 * upstream genuinely being unreachable.
 *
 * The distinction matters for the status we answer with: a timeout means we
 * waited and gave up, which is a gateway failure (504), while a refused
 * connection is a bad gateway (502). Both are surfaced to the client the same
 * way, but the logs should not call a slow upstream "unreachable".
 */
export function isUpstreamTimeout(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "TimeoutError" || error.name === "AbortError")
	);
}
