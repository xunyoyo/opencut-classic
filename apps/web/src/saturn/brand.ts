import { z } from "zod";

/**
 * The branding of the site the user came in from.
 *
 * Every deployment of this editor otherwise shows its own name, but the editor
 * is reached from AI-Saturn — and AI-Saturn serves several brands off one
 * codebase, differentiated by the `Host` the browser asked for. That lookup
 * cannot happen here: this is a different origin, so asking the platform's own
 * branding endpoint would answer for *this* host and hand an agency site's
 * users the platform's name and logo.
 *
 * The brand therefore arrives the only way anything crosses that boundary —
 * on the URL that `/saturn-open` is opened with — and is kept here so the
 * editor's own chrome (title, header, footer) keeps saying the right name on
 * every later navigation, not just the one the link landed on.
 *
 * Absent means "no upstream branding": either a brand-agnostic deployment or a
 * link that carried none, and the editor falls back to its own name.
 */
export const saturnBrandSchema = z.object({
	/** What to call the site: the platform's own name, or an agency's. */
	siteName: z.string().min(1),
	/** One line at the bottom of the page. Upstream sends one already formatted. */
	copyrightText: z.string().optional(),
	/** Wide logo, for the header. */
	logoUrl: z.string().optional(),
	/** Square icon, for the collapsed header and the favicon. */
	faviconUrl: z.string().optional(),
	/**
	 * Whether upstream wants text instead of an image logo.
	 *
	 * Agency sites that have not uploaded a logo set this: falling back to the
	 * platform's logo image would print the platform's name across an agency's
	 * console, which is the exact thing the flag exists to prevent.
	 */
	useTextLogo: z.boolean().optional(),
});

export type SaturnBrand = z.infer<typeof saturnBrandSchema>;

const BRAND_KEY = "saturn-brand";

/**
 * Reads the brand off the query string.
 *
 * Values are URL-encoded by the caller, so a name with spaces or CJK arrives
 * intact. Anything malformed is dropped rather than defaulted: a half-applied
 * brand (the agency's name with the platform's logo) reads as a bug in a way
 * that no brand at all does not.
 */
export function readBrandFromParams(params: URLSearchParams): SaturnBrand | null {
	const siteName = params.get("siteName");
	if (!siteName) return null;

	const candidate = {
		siteName,
		copyrightText: params.get("copyrightText") ?? undefined,
		logoUrl: params.get("logoUrl") ?? undefined,
		faviconUrl: params.get("faviconUrl") ?? undefined,
		useTextLogo: params.get("useTextLogo") === "1" ? true : undefined,
	};

	const parsed = saturnBrandSchema.safeParse(candidate);
	return parsed.success ? parsed.data : null;
}

/** Persists the brand so it survives navigation within the editor. */
export function saveBrand({ brand }: { brand: SaturnBrand }): void {
	try {
		localStorage.setItem(BRAND_KEY, JSON.stringify(brand));
	} catch (error) {
		// Private mode or a full quota. The editor still works, it just reverts to
		// its own name after a reload — not worth failing the entry over.
		console.warn("[saturn] 无法保存站点品牌：", error);
	}
}

/**
 * The brand this browser last entered with.
 *
 * Null on the server and during the first client render, because localStorage
 * is not readable there. Callers that render text must therefore tolerate a
 * name that arrives one paint late — or, better, take it from a context that is
 * populated before anything branded is drawn.
 */
export function loadBrand(): SaturnBrand | null {
	try {
		const raw = localStorage.getItem(BRAND_KEY);
		if (!raw) return null;

		const parsed = saturnBrandSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function clearBrand(): void {
	try {
		localStorage.removeItem(BRAND_KEY);
	} catch {
		// Nothing to do — the brand is cosmetic and the next read just misses.
	}
}
