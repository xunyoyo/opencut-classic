"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { loadBrand, type SaturnBrand } from "@/saturn/brand";

/**
 * The brand the editor should present itself under.
 *
 * Read from storage rather than passed down from a server component: the brand
 * arrives on the URL of one specific page (`/saturn-open`) and has to outlive
 * that navigation, so localStorage is the source of truth and a client provider
 * is the only thing that can see it.
 *
 * Deliberately *not* applied during the first render. Rendering the stored name
 * on the server is impossible — there is no localStorage there — so a server
 * render would emit the default and the client's first pass would emit the
 * agency's, which React reports as a hydration mismatch. Waiting for the effect
 * costs one frame of the default name on a cold load, which is a far smaller
 * cost than a mismatched tree.
 */
const BrandContext = createContext<SaturnBrand | null>(null);

export function SaturnBrandProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [brand, setBrand] = useState<SaturnBrand | null>(null);

	useEffect(() => {
		setBrand(loadBrand());
	}, []);

	return (
		<BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
	);
}

/** The upstream brand, or null when this deployment has none. */
export function useSaturnBrand(): SaturnBrand | null {
	return useContext(BrandContext);
}
