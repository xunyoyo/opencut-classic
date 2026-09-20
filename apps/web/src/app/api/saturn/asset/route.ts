import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";

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
	if (target.protocol !== "https:" || !allowedHosts.has(target.hostname)) {
		return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
	}

	try {
		const upstream = await fetch(target, { cache: "no-store" });

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
		console.error("Failed to proxy AI-Saturn asset:", error);
		return NextResponse.json(
			{ error: "Failed to proxy asset" },
			{ status: 502 },
		);
	}
}
