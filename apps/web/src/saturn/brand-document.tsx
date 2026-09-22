"use client";

import { useEffect } from "react";
import { useSaturnBrand } from "./brand-provider";

/**
 * Applies the upstream brand to the browser chrome.
 *
 * Two things live outside React's tree and so cannot be rendered declaratively:
 * the document title and the favicon link. Both are set here rather than in a
 * server component because the brand is only knowable on the client.
 *
 * Restores the page's own title on unmount so navigating away from a branded
 * entry does not leave the agency's name on an unbranded page.
 */
export function SaturnBrandDocument() {
	const brand = useSaturnBrand();

	useEffect(() => {
		if (!brand) return;

		const previousTitle = document.title;
		document.title = brand.siteName;

		// Upstream already resolved which of its own icons applies, so this is a
		// straight swap — no theme awareness needed on this side.
		let link: HTMLLinkElement | null = null;
		let previousHref: string | null = null;
		if (brand.faviconUrl) {
			link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
			if (link) {
				previousHref = link.href;
				link.href = brand.faviconUrl;
			}
		}

		return () => {
			document.title = previousTitle;
			if (link && previousHref) link.href = previousHref;
		};
	}, [brand]);

	return null;
}
