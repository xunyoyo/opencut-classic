import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Proxies AI-Saturn's project list for the current user.
 *
 * The browser cannot call AI-Saturn directly (no CORS), so this route relays
 * the request server-side. The caller's RuoYi token is passed straight
 * through — this route grants no access beyond what the user already has.
 *
 * Upstream: GET /project/info/list
 * Returns the full AjaxResult envelope; the client narrows it with zod.
 */
export async function GET(request: NextRequest) {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const upstream = new URL("/project/info/list", webEnv.SATURN_API_BASE);

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
		console.error("Failed to reach AI-Saturn for project list:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}
