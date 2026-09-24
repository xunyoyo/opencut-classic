import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { toPublicAssetUrl } from "../asset-origin";
import { isUpstreamTimeout } from "../upstream-timeout";

/**
 * Proxies AI-Saturn media files so the browser can read them as blobs.
 *
 * The OSS bucket behind the CDN is publicly readable but has no CORS rules
 * configured (an `OPTIONS` preflight against either the CDN or the origin
 * returns 403). A `<video src>` would still play, but OpenCut needs the bytes
 * in OPFS to edit and export, and `fetch` is what gets blocked. Relaying the
 * download through our own origin makes it same-origin.
 */

const allowedHosts = new Set(
	webEnv.SATURN_ASSET_HOSTS.split(",")
		.map((host) => host.trim())
		.filter(Boolean),
);

/**
 * How long the CDN is allowed to take before it has to have produced response
 * headers.
 *
 * Deliberately a header deadline and not a download deadline. This route is the
 * one place in `/api/saturn` that does not return a row: it relays media bytes,
 * and the response below is a stream handed straight to the client. A deadline
 * covering the whole request would be a deadline on the transfer itself, and
 * the files are tens to hundreds of megabytes — on a slow connection a legal
 * download outlives any constant that is also short enough to notice a stall,
 * so a total timeout here fails large files rather than wedged ones. The
 * deadline is therefore cleared the moment headers arrive (see the fetch
 * below); once the body starts flowing, progress is its own signal, and a peer
 * that goes silent mid-body eventually trips the client's own abort.
 *
 * What the timeout still buys is the failure the other routes were missing: a
 * socket that connects and then never answers. That one leaves the `await`
 * pending and the user on a download that never starts, and unlike a large file
 * it is indistinguishable from success until something gives up on it. Ten
 * seconds is far past a healthy CDN (headers come back in milliseconds, the
 * body is what is slow) and, because it is bounded by the header round trip
 * rather than by the transfer, it is safe to keep short.
 */
const HEADERS_TIMEOUT_MS = 10_000;

export async function GET(request: NextRequest) {
	const rawUrl = request.nextUrl.searchParams.get("url");
	if (!rawUrl) {
		return NextResponse.json(
			{ error: "Missing url parameter" },
			{ status: 400 },
		);
	}

	let target: URL;
	try {
		target = new URL(rawUrl);
	} catch {
		return NextResponse.json(
			{ error: "Malformed url parameter" },
			{ status: 400 },
		);
	}

	// Without this check the route would fetch any URL a caller supplies,
	// including private addresses reachable from the server. The allowlist is
	// the whole security boundary here.
	//
	// Checked against the caller's URL rather than the rewritten one: the
	// rewrite only ever moves between allowlisted hosts, so testing the input
	// keeps this a single gate on what was actually asked for.
	if (target.protocol !== "https:" || !allowedHosts.has(target.hostname)) {
		return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
	}

	// Callers normally pass an already-rewritten URL from the shot metadata.
	// Older paths that hold an upstream `storePath` verbatim land here instead,
	// so the fetch itself is pinned to the serving origin too — otherwise those
	// requests would keep going to whichever host the shot happened to be
	// uploaded through.
	const fetchUrl = toPublicAssetUrl(target.toString());

	try {
		// The controller is what lets the deadline above cover only the header
		// phase: `clearTimeout` on the line after the fetch disarms it for good,
		// since a timer that never fires cannot abort and an
		// `AbortController.abort()` that was never called does not poison the
		// response it already produced. Using `AbortSignal.timeout()` directly
		// would not work here — its deadline is built in and runs to completion
		// regardless, so a 200MB transfer on a slow link would be torn down
		// mid-body by the very signal meant to catch a silent CDN.
		const headersOnly = new AbortController();
		const headerTimer = setTimeout(() => headersOnly.abort(), HEADERS_TIMEOUT_MS);

		let upstream: Response;
		try {
			upstream = await fetch(fetchUrl, {
				cache: "no-store",
				signal: headersOnly.signal,
			});
		} finally {
			// Runs before the body is read, so the abort above reaches the
			// connection setup and nothing downstream.
			clearTimeout(headerTimer);
		}

		if (!upstream.ok || !upstream.body) {
			return NextResponse.json(
				{ error: `Asset fetch returned ${upstream.status}` },
				{ status: 502 },
			);
		}

		const contentLength = upstream.headers.get("content-length");

		// Stream rather than buffer: shot videos are large enough that reading
		// them into the route would spike memory once imports run concurrently.
		return new NextResponse(upstream.body, {
			headers: {
				"Content-Type":
					upstream.headers.get("content-type") ?? "application/octet-stream",
				...(contentLength ? { "Content-Length": contentLength } : {}),
				"Cache-Control": "private, max-age=3600",
			},
		});
	} catch (error) {
		// A 504 rather than the 502 below: the origin is reachable, it just never
		// produced headers, and the client's retry logic reads those two the same
		// way it does for the JSON routes.
		if (isUpstreamTimeout(error)) {
			console.error("AI-Saturn asset origin sent no headers in time:", error);
			return NextResponse.json(
				{ error: "Asset origin timed out" },
				{ status: 504 },
			);
		}

		console.error("Failed to proxy AI-Saturn asset:", error);
		return NextResponse.json(
			{ error: "Failed to proxy asset" },
			{ status: 502 },
		);
	}
}
