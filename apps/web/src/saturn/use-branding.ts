"use client";

import { useSaturnBrand } from "./brand-provider";
import { DEFAULT_LOGO_URL, SITE_INFO } from "@/site/brand";

/**
 * What to call this editor, resolved for display.
 *
 * One place so the header, footer, document title and dialogs cannot drift
 * apart — a page branded in two different names is more jarring than either
 * name used consistently.
 *
 * `useSaturnBrand` is null until its effect runs and null forever on a
 * deployment nobody branded, so every field here falls back to this app's own
 * identity. The one exception is `useTextLogo`, which only ever comes from
 * upstream: an agency that has not uploaded a logo asks for text, and falling
 * back to the platform's logo image would print the platform's name across
 * their console — the exact thing the flag exists to prevent.
 */
export function useBranding(): {
	siteName: string;
	logoUrl: string | null;
	faviconUrl: string | null;
	copyrightText: string;
	useTextLogo: boolean;
} {
	const brand = useSaturnBrand();

	return {
		siteName: brand?.siteName ?? SITE_INFO.title,
		logoUrl: brand?.logoUrl ?? null,
		faviconUrl: brand?.faviconUrl ?? null,
		copyrightText:
			brand?.copyrightText ??
			`© ${new Date().getFullYear()} ${SITE_INFO.title}, All Rights Reserved`,
		// Upstream says to use text only when it has a brand *and* no logo. With
		// no brand at all this is our own deployment, so our own logo applies.
		useTextLogo: brand !== null && (brand.useTextLogo ?? !brand.logoUrl),
	};
}

/** The logo to draw, or null when the caller should render the site name. */
export function resolveLogoUrl({
	logoUrl,
}: {
	logoUrl: string | null;
}): string {
	return logoUrl ?? DEFAULT_LOGO_URL;
}
