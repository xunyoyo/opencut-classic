import { webEnv } from "@/env/web";

/**
 * Rewrites an AI-Saturn asset URL onto the origin we serve from.
 *
 * The same bucket is addressed through several hosts, because `store_path` in
 * AI-Saturn's database records whichever domain was configured at the moment of
 * upload rather than a stable identity for the file: everything uploaded before
 * September 2026 points at the raw OSS endpoint, later uploads at the CDN, and
 * the path segment is identical either way. Which host to hand the browser is a
 * hosting decision, so it is applied here, once, rather than being backfilled
 * into the database or frozen into the saved timelines.
 *
 * Only the origin is replaced, and only for hosts already on the asset proxy's
 * allowlist — an unparseable or unknown URL is returned untouched so that a
 * value the allowlist would reject does not become a rewritten URL that looks
 * legitimate.
 */
export function toPublicAssetUrl(rawUrl: string | null | undefined): string {
	if (!rawUrl) return "";

	const rawBase = webEnv.SATURN_ASSET_PUBLIC_BASE.trim();
	if (!rawBase) return rawUrl;

	let base: URL;
	let target: URL;
	try {
		// Trailing slashes dropped so the origin comparison below is not
		// defeated by `https://cdn.example.com/` versus `https://cdn.example.com`.
		base = new URL(rawBase);
		target = new URL(rawUrl);
	} catch {
		return rawUrl;
	}

	// Already on the serving origin — the common case once the shot metadata
	// has been through here once.
	if (target.hostname === base.hostname) return rawUrl;

	const allowedHosts = new Set(
		webEnv.SATURN_ASSET_HOSTS.split(",")
			.map((host) => host.trim())
			.filter(Boolean),
	);

	// Only known upstream hosts are moved. Anything else is left alone rather
	// than pointed at a host the allowlist would not have accepted anyway.
	if (!allowedHosts.has(target.hostname)) return rawUrl;

	return `${base.origin}${target.pathname}${target.search}`;
}

/**
 * Walks AI-Saturn's shot tree and rewrites every `videoUrl` in place.
 *
 * Recursive because `subShots` nests to arbitrary depth, and in place because
 * the payload is a single response parsed and forwarded once — copying a tree
 * that can hold thousands of shots would be pure overhead.
 */
export function rewriteShotTreeAssetUrls<
	T extends { videoUrl?: string | null; subShots?: T[] | null },
>(shots: T[]): T[] {
	for (const shot of shots) {
		if (shot.videoUrl) shot.videoUrl = toPublicAssetUrl(shot.videoUrl);
		if (shot.subShots?.length) rewriteShotTreeAssetUrls(shot.subShots);
	}
	return shots;
}
