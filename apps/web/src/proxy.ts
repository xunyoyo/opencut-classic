/**
 * Request-time interception, at the one place that sees every request.
 *
 * Formerly `middleware.ts`; Next 16 renamed the convention to `proxy.ts` and
 * moved it onto the Node.js runtime (upstream warns on the old filename, and
 * refuses to build if both files exist). The rename is what makes the session
 * gate further down possible — signing a cookie needs `node:crypto`, which the
 * old edge runtime did not have.
 *
 * Two jobs, in this order:
 *
 *   1. Hide the upstream project's public site from this deployment.
 *   2. Turn away requests that carry no valid AI-Saturn session.
 *
 * The order is load-bearing. A marketing page must 404 whether or not the
 * caller is signed in — redirecting it to a login screen would confirm that
 * the route exists, which is the opposite of hiding it.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
	SESSION_COOKIE_NAME,
	openSession,
} from "@/saturn/session-cookie";

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

/**
 * Pages reachable without a session.
 *
 * `/saturn-open` is the entry point and must be open — it is where the token
 * arrives from the platform and where the session is established. Closing it
 * would make the editor unreachable by anyone.
 */
const PUBLIC_PATHS = new Set(["saturn-open"]);

/**
 * API paths reachable without a session.
 *
 * `/api/saturn/session` is the exchange that mints the cookie — requiring a
 * cookie to reach it would be a closed loop, and the editor would be
 * impossible to enter.
 *
 * The rest are reachability probes: a healthcheck that needs a login reports
 * the editor as down, which is worse than useless.
 */
const PUBLIC_API_PREFIXES = [
	"/api/health",
	"/api/auth",
	"/api/saturn/session",
];

export async function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// First, and unconditionally: a marketing page is hidden whether or not the
	// caller is signed in. Sending it to a login screen instead would confirm
	// the route exists, which is the opposite of what the 404 is for.
	if (UPSTREAM_MARKETING.has(firstSegment(pathname))) {
		return new NextResponse("Not Found", { status: 404 });
	}

	if (PUBLIC_PATHS.has(firstSegment(pathname))) return NextResponse.next();
	if (PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		return NextResponse.next();
	}

	// Signature and expiry only — no I/O. The token was checked against the
	// platform when the cookie was minted (`/api/saturn/session`); asking again
	// here would put a backend round trip in front of every RSC prefetch and
	// make the platform's uptime a hard dependency of the editor's routing.
	const session = openSession({
		value: request.cookies.get(SESSION_COOKIE_NAME)?.value,
	});
	if (session) return NextResponse.next();

	// API callers get JSON, not a redirect: a 302 would hand `fetch()` an HTML
	// body to parse. The transcription client already branches on 401 and has
	// a message ready for exactly this.
	if (pathname.startsWith("/api/")) {
		return NextResponse.json(
			{ error: "登录态已失效，请从 AI-Saturn 重新进入" },
			{ status: 401 },
		);
	}

	// A page. Send the user where they can re-establish a session, remembering
	// where they were headed so the round trip does not lose their place.
	const target = new URL("/saturn-open", request.url);
	target.searchParams.set("reason", "expired");
	if (pathname !== "/") target.searchParams.set("from", pathname);

	const redirect = NextResponse.redirect(target);
	// Explicit, not left to the CDN's defaults: a cached redirect would bounce
	// every visitor to the entry page forever, signed in or not.
	redirect.headers.set("Cache-Control", "private, no-store, max-age=0");
	return redirect;
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
// Everything the matcher does cover is then dispatched by the proxy body.
export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|manifest.json|browserconfig.xml|landing-page-dark.png|icons/|logos/|flags/|fonts/|shapes/|effects/|open-graph/|platform-guides/).*)",
	],
};

