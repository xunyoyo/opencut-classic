import { useState, useMemo, useCallback, useEffect } from "react";
import {
	getCachedFontAtlas,
	loadFontAtlas,
	clearFontAtlasCache,
} from "@/fonts/google-fonts";
import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import { isFontAvailable } from "@/fonts/hosted-fonts";

type Status = "idle" | "loading" | "error";

export function useFontAtlas({ open }: { open: boolean }) {
	const [atlas, setAtlas] = useState<FontAtlas | null>(() =>
		getCachedFontAtlas(),
	);
	const [status, setStatus] = useState<Status>(() =>
		getCachedFontAtlas() ? "idle" : "loading",
	);

	useEffect(() => {
		if (!open || atlas) return;

		setStatus("loading");
		loadFontAtlas().then((data) => {
			if (data) {
				setAtlas(data);
				setStatus("idle");
			} else {
				setStatus("error");
			}
		});
	}, [open, atlas]);

	const retry = useCallback(() => {
		clearFontAtlasCache();
		setStatus("loading");
		loadFontAtlas().then((data) => {
			if (data) {
				setAtlas(data);
				setStatus("idle");
			} else {
				setStatus("error");
			}
		});
	}, []);

	// The atlas ships previews for every family Google offers, but a deployment
	// pointed at a mirror can only load what was copied there. Listing the rest
	// would mean picking a font and watching nothing happen.
	const fontNames = useMemo(() => {
		if (!atlas) return [];
		const families = Object.keys(atlas.fonts).filter((family) =>
			isFontAvailable({ family }),
		);
		return [...families, ...SYSTEM_FONTS].sort();
	}, [atlas]);

	return { atlas, status, fontNames, retry };
}
