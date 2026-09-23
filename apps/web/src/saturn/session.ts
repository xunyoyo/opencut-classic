/**
 * Holds the AI-Saturn token for the rest of the tab's life.
 *
 * The token arrives as a query parameter on `/saturn-open` and is spent there
 * fetching the shot list. Transcription happens later, from the captions panel
 * inside the editor, by which point that URL is long gone — so the landing
 * page stashes it here on the way through.
 *
 * sessionStorage rather than localStorage: this is a credential, and it should
 * not outlive the tab. It is deliberately kept out of the persisted zustand
 * stores for the same reason.
 *
 * This is no longer the only copy. `./session-cookie` mirrors the token into a
 * signed cookie, because `proxy.ts` runs on the server and cannot see
 * sessionStorage — that cookie is what admits the request, and it is specified
 * for a longer life than this one on purpose. The two are not redundant: this
 * copy is what the client sends as an `Authorization` header, the cookie is
 * what the gate reads.
 */

const STORAGE_KEY = "saturn-token";

export function storeSaturnToken({ token }: { token: string }): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, token);
	} catch {
		// Private browsing modes can refuse sessionStorage. Losing the token only
		// costs the remote transcription option, so this is not worth surfacing.
	}
}

export function readSaturnToken(): string | null {
	try {
		return sessionStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

/**
 * Forgets the token, when the server has already said it is no good.
 *
 * Called where a 401 comes back, so the client stops attaching a token that
 * every later request will be rejected for — otherwise the failure repeats on
 * each panel the user opens, and the first one looks like the only problem.
 *
 * The cookie is not cleared here: it is the gate's, and will be replaced or
 * rejected on its own at the next entry.
 */
export function clearSaturnToken(): void {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to do — an unreadable store has no token to forget either.
	}
}
