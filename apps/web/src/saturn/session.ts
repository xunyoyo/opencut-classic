/**
 * Holds the AI-Saturn token for the rest of the tab's life.
 *
 * The token arrives as a query parameter on /saturn-import and is spent there
 * fetching the shot list. Transcription happens later, from the captions panel
 * inside the editor, by which point that URL is long gone — so the import
 * stashes it here on the way through.
 *
 * sessionStorage rather than localStorage: this is a credential, and it should
 * not outlive the tab. It is deliberately kept out of the persisted zustand
 * stores for the same reason.
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
