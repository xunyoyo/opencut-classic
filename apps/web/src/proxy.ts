/**
 * Request-time interception, at the one place that sees every request.
 *
 * Formerly `middleware.ts`; Next 16 renamed the convention to `proxy.ts` and
 * moved it onto the Node.js runtime (upstream warns on the old filename, and
 * refuses to build if both files exist).
 */

import { NextResponse } from "next/server";

/**
 * Upstream's public site: routes that promote OpenCut itself — its roadmap,
 * sponsors, contributors, brand assets and blog — or state terms and a privacy
 * policy for a hosted service we are not the ones running. None of it belongs
 * in an internal tool, and the privacy policy in particular describes data
 * handling that is not ours to claim. The changelog is upstream's own release
 * notes, written for their users about their releases, so it goes the same way.
 *
 * The pages are left in the tree rather than deleted, so merging from upstream
 * stays clean; the routes simply do not resolve here. A plain 404 in preference
 * to a redirect: as far as this deployment is concerned the page does not
 * exist, and bouncing people to the home page would suggest it had merely moved.
 */
const UPSTREAM_MARKETING = new Set([
	"blog",
	"brand",
	"changelog",
	"contributors",
	"privacy",
	"roadmap",
	"sponsors",
	"terms",
]);

/** First path segment, e.g. "/blog/hello" -> "blog". */
function firstSegment(pathname: string): string {
	return pathname.split("/")[1] ?? "";
}

export function proxy(request: Request) {
	const { pathname } = new URL(request.url);

	if (UPSTREAM_MARKETING.has(firstSegment(pathname))) {
		return new NextResponse("Not Found", { status: 404 });
	}

	return NextResponse.next();
}

// A negative matcher, so everything the app serves is covered except the
// things that must never be gated:
//
//   _next/static  the app's own JS and CSS. Gating it yields a blank page,
//                 which reads as a bundling bug rather than an auth failure.
//   public/*      directories the editor loads as media. Gating these breaks
//                 playback and the effects/flag/font pickers in ways that look
//                 unrelated to authentication.
//
// Every route is matched rather than the eight marketing ones the previous
// version listed: the session gate that follows covers all of them, and a
// positive list would have quietly confined it to the marketing pages.
export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|manifest.json|browserconfig.xml|landing-page-dark.png|icons/|logos/|flags/|fonts/|shapes/|effects/|open-graph/|platform-guides/).*)",
	],
};
