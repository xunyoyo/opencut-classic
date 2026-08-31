import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

/**
 * Proxies AI-Saturn's shot list.
 *
 * The browser cannot call AI-Saturn directly: the backend ships no CORS
 * configuration, so a cross-origin request from the editor is rejected before
 * it reaches a controller. Forwarding server-side sidesteps CORS entirely and
 * keeps the integration contained to this repo.
 *
 * The caller's RuoYi token is passed straight through — this route grants no
 * access of its own, it only relays whatever the user is already authorized for.
 */

const searchParamsSchema = z.object({
	viewId: z.coerce.number().int().positive(),
	type: z.coerce.number().int().min(1).max(2).default(1),
});

export async function GET(request: NextRequest) {
	const parsed = searchParamsSchema.safeParse(
		Object.fromEntries(request.nextUrl.searchParams),
	);

	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid viewId or type" },
			{ status: 400 },
		);
	}

	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const { viewId, type } = parsed.data;
	const upstream = new URL(
		"/project/storyboard/queryShotList",
		webEnv.SATURN_API_BASE,
	);
	upstream.searchParams.set("viewId", String(viewId));
	upstream.searchParams.set("type", String(type));

	try {
		const response = await fetch(upstream, {
			headers: { Authorization: authorization },
			cache: "no-store",
		});

		if (!response.ok) {
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				// Keep 401 distinguishable so the UI can prompt for a fresh token
				// instead of reporting a generic upstream failure.
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		return NextResponse.json(await response.json());
	} catch (error) {
		console.error("Failed to reach AI-Saturn:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}
