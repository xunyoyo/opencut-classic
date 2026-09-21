import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Proxies AI-Saturn's project-wide shot metadata.
 *
 * Upstream: GET /project/media/projectShots
 *
 * Everything the editor needs to lay out a whole project — shot numbers,
 * durations, dialogue, framing, and the CDN address of each shot video — in a
 * single request. Media bytes are deliberately not part of this: they are
 * fetched per clip through /api/saturn/asset.
 *
 * The upstream endpoint takes no parameters, reading the project from the
 * caller's session instead, so there is nothing to forward but the token.
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

	try {
		const response = await fetch(upstream, {
			headers: { Authorization: authorization },
			cache: "no-store",
		});

		if (!response.ok) {
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		return NextResponse.json(await response.json());
	} catch (error) {
		console.error("Failed to reach AI-Saturn for project shots:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}
