import { NextResponse } from "next/server";

/**
 * Hides the upstream project's public site from this deployment.
 *
 * These routes promote OpenCut itself — its roadmap, sponsors, contributors,
 * brand assets and blog — or state terms and a privacy policy for a hosted
 * service we are not the ones running. None of it belongs in an internal
 * tool, and the privacy policy in particular describes data handling that is
 * not ours to claim.
 *
 * The pages are left in the tree rather than deleted, so merging from
 * upstream stays clean; the routes simply do not resolve here. A plain 404 in
 * preference to a redirect: as far as this deployment is concerned the page
 * does not exist, and bouncing people to the home page would suggest it had
 * merely moved.
 */
export function middleware() {
	return new NextResponse("Not Found", { status: 404 });
}

// Each route is listed twice, bare and with a wildcard. Whether ":path*"
// alone also covers the bare segment depends on how the pattern is compiled,
// and a page that stays reachable is the one failure worth ruling out.
export const config = {
	matcher: [
		"/blog",
		"/blog/:path*",
		"/brand",
		"/brand/:path*",
		"/contributors",
		"/contributors/:path*",
		"/privacy",
		"/privacy/:path*",
		"/roadmap",
		"/roadmap/:path*",
		"/sponsors",
		"/sponsors/:path*",
		"/terms",
		"/terms/:path*",
	],
};
