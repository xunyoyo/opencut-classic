import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { rewriteShotTreeAssetUrls } from "../asset-origin";

/**
 * Proxies AI-Saturn's project-wide shot metadata.
 *
 * Upstream: GET /project/media/projectShots?projectId=<id>
 *
 * Everything the editor needs to lay out a whole project — shot numbers,
 * durations, dialogue, framing, and the CDN address of each shot video — in a
 * single request. Media bytes are deliberately not part of this: they are
 * fetched per clip through /api/saturn/asset.
 *
 * The project id is forwarded rather than left to upstream's session lookup.
 * That lookup reads a "currently active project" value the platform keeps per
 * user, which a second browser tab can change under the editor's feet — the
 * editor would then be served a different project's shots. Sending the id the
 * user actually opened lets upstream check membership and use it instead.
 */
export async function GET(request: NextRequest) {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const upstream = new URL(
		"/project/media/projectShots",
		webEnv.SATURN_API_BASE,
	);
	const projectId = request.nextUrl.searchParams.get("projectId");
	if (projectId) {
		upstream.searchParams.set("projectId", projectId);
	}

	try {
		const response = await fetch(upstream, {
			headers: { Authorization: authorization },
			cache: "no-store",
		});

		if (!response.ok) {
			// Upstream is a RuoYi app: it answers its own business failures with
			// HTTP 200 and a non-200 `code` in the body, which is how the client
			// surfaces things like "你没有这个项目的权限". A non-ok status here
			// therefore means the request never reached that logic — 401 is the
			// login having expired, anything else is the service being unreachable
			// or broken, and there is no body worth forwarding.
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		const payload = await response.json();

		// Upstream `videoUrl` is whatever host was configured when the shot was
		// rendered — raw OSS for anything predating the CDN cutover. Rewritten
		// here so the client only ever sees the one origin we serve from; see
		// asset-origin.ts.
		if (Array.isArray(payload?.data)) {
			rewriteShotTreeAssetUrls(payload.data);
		}

		return NextResponse.json(payload);
	} catch (error) {
		console.error("Failed to reach AI-Saturn for project shots:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}
