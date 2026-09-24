/**
 * Browser side of the session exchange.
 *
 * Kept apart from `./session-cookie`, which is server-only: it imports
 * `node:crypto` and must never be pulled into a client bundle.
 */

import { clearSaturnToken } from "./session";
import { clientFetchSignal, isFetchTimeout } from "./fetch-timeout";

/**
 * Trades an AI-Saturn token for the editor's session cookie.
 *
 * Must succeed before the user is allowed further in — the gate in `proxy.ts`
 * reads only the cookie, so a browser that reaches `/editor/:id` without one
 * is sent straight back out. Calling this is therefore part of entering, not
 * a background nicety.
 *
 * Throws with a message worth showing: the two failure modes (the platform
 * rejected the token, or the platform could not be reached) need different
 * user actions — re-enter from AI-Saturn, versus try again in a moment.
 */
export async function establishSession({
	token,
	signal,
}: {
	/** The `Authorization` value, scheme prefix included. */
	token: string;
	signal?: AbortSignal;
}): Promise<void> {
	let response: Response;
	try {
		response = await fetch("/api/saturn/session", {
			method: "POST",
			headers: { Authorization: token },
			// Deadlined here rather than left to the route: the server's own
			// 10s bounds its call to `/getInfo`, not the browser's call to us,
			// and the caller of this function blocks the whole page on it.
			signal: clientFetchSignal(signal),
		});
	} catch (error) {
		// A deadline is not the same failure as an unreachable server, and the
		// two need different words: "check your network" is wrong advice for a
		// server that took the request and never answered. The caller renders
		// whatever message this throws, so it has to be the true one.
		if (isFetchTimeout(error)) {
			throw new Error("建立登录态超时，请重试");
		}
		throw new Error("无法连接服务器，请检查网络后重试");
	}

	if (response.ok) return;

	// 401 means the platform rejected this token outright, so the copy in
	// sessionStorage is dead too — and it is the copy the captions panel and the
	// points readout send as an `Authorization` header. Clearing it here is what
	// stops those from failing one by one against a credential the server has
	// already refused.
	if (response.status === 401) clearSaturnToken();

	const message = await response
		.json()
		.then((payload: unknown) =>
			typeof payload === "object" &&
			payload !== null &&
			"error" in payload &&
			typeof payload.error === "string"
				? payload.error
				: null,
		)
		.catch(() => null);

	throw new Error(message ?? `建立登录态失败（HTTP ${response.status}）`);
}
