/**
 * The signed cookie that stands in for an AI-Saturn session at the edge.
 *
 * Why this exists at all: the token normally lives in `sessionStorage`
 * (`./session`), and `sessionStorage` is invisible to `proxy.ts` — that runs
 * on the server, which has no access to the browser's per-tab storage. The
 * gate needs something it can read off the request, so the token is mirrored
 * into a cookie at the moment the user enters from AI-Saturn.
 *
 * Why it is signed rather than the bare token: the proxy trusts this cookie
 * to decide whether a request may proceed. A plaintext cookie would let any
 * client mint its own session by writing one. The HMAC is what makes the
 * cookie an assertion rather than a claim, and it is why `proxy.ts` can admit
 * a request without asking the backend on every navigation.
 *
 * Why 7 days, when `./session` deliberately keeps its copy for one tab only:
 * this cookie *is* the gate, so a tab-lifetime cookie would send every user
 * back through AI-Saturn each time they open a new tab. The two stores are
 * therefore specified differently on purpose — `sessionStorage` holds a
 * working copy for the live tab, the cookie holds the gate's own credential.
 * The token inside is the same secret either way, so the exposure is not
 * widened by the longer life: anything that can read one can read the other.
 *
 * Read off `process.env` directly rather than through `@/env/web`: that module
 * parses the full server-side schema at import time and would pull zod into
 * the proxy bundle. The same precedent is documented at `@/env/web` for the
 * transcription worker.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "saturn-session";

/** Cookie format version, so a future change can invalidate old cookies. */
const VERSION = "v1";

/**
 * How long a session stays valid, refreshed on every successful entry.
 *
 * Slides rather than fixed: entering again from the platform re-mints the
 * cookie with a fresh deadline, so a user who works in the editor regularly
 * never has to think about it.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The signing key.
 *
 * Not defaulted to a constant: a shared fallback would mean every deployment
 * that forgot to set this accepts cookies signed by every other deployment
 * that forgot too. Missing is a deployment error, and the gate fails closed
 * on it rather than admitting everyone.
 */
function secret(): string | null {
	return process.env.SATURN_SESSION_SECRET || null;
}

function sign({ payload, key }: { payload: string; key: string }): string {
	return createHmac("sha256", key).update(payload).digest("base64url");
}

/** Packs a token into a signed cookie value. */
export function sealSession({
	token,
	now = Date.now(),
	ttlMs = SESSION_TTL_MS,
}: {
	/**
	 * The token as upstream expects it, scheme prefix included — the same value
	 * that goes in an `Authorization` header. Stored whole so a caller that
	 * reads it back out of the cookie can forward it without rebuilding it,
	 * which is also why the client's own copy is the full header value.
	 */
	token: string;
	now?: number;
	ttlMs?: number;
}): string | null {
	const key = secret();
	if (!key) return null;

	const expiresAt = now + ttlMs;
	const payload = `${VERSION}.${expiresAt}.${Buffer.from(token, "utf8").toString("base64url")}`;
	return `${payload}.${sign({ payload, key })}`;
}

export interface OpenedSession {
	token: string;
	expiresAt: number;
}

/**
 * Verifies a cookie value and returns the token it carries.
 *
 * Returns null for every failure — no secret configured, malformed, bad
 * signature, expired — because the caller does the same thing in all of them:
 * treat the request as unauthenticated. Distinguishing them here would only
 * invite a caller to get one of the cases wrong.
 */
export function openSession({
	value,
	now = Date.now(),
}: {
	value: string | undefined;
	now?: number;
}): OpenedSession | null {
	const key = secret();
	if (!key || !value) return null;

	const parts = value.split(".");
	if (parts.length !== 4) return null;

	const [version, expiresRaw, tokenRaw, signature] = parts;
	if (version !== VERSION) return null;

	const payload = `${version}.${expiresRaw}.${tokenRaw}`;
	const expected = sign({ payload, key });

	// Constant-time, and length-checked first: `timingSafeEqual` throws on
	// differing lengths, which would turn a malformed cookie into a 500.
	const expectedBuf = Buffer.from(expected);
	const actualBuf = Buffer.from(signature);
	if (expectedBuf.length !== actualBuf.length) return null;
	if (!timingSafeEqual(expectedBuf, actualBuf)) return null;

	const expiresAt = Number(expiresRaw);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

	let token: string;
	try {
		token = Buffer.from(tokenRaw, "base64url").toString("utf8");
	} catch {
		return null;
	}
	if (!token) return null;

	return { token, expiresAt };
}

/**
 * Attributes for the `Set-Cookie` that mints a session.
 *
 * `SameSite=Lax` is the load-bearing one. Entry is a cross-site top-level
 * navigation from the AI-Saturn platform, which Lax permits; cross-site POSTs
 * are refused, which is what keeps another origin from driving the editor's
 * own API routes with a borrowed cookie.
 *
 * `Secure` is conditional because production is HTTPS behind the CDN while
 * local development is plain `http://localhost:3000`, where a Secure cookie
 * is silently dropped and login becomes impossible.
 *
 * Not `HttpOnly`, deliberately: `@/saturn/points` and the transcription
 * service read the token out of `sessionStorage` and send it as an
 * `Authorization` header, and moving the cookie to HttpOnly would break both
 * without removing the sessionStorage copy they depend on. See the note at
 * the top of this file — the exposure is unchanged, not widened.
 */
export function sessionCookieOptions({
	maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000),
}: {
	maxAgeSeconds?: number;
} = {}): {
	path: string;
	httpOnly: boolean;
	sameSite: "lax";
	secure: boolean;
	maxAge: number;
} {
	return {
		path: "/",
		httpOnly: false,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		maxAge: maxAgeSeconds,
	};
}
