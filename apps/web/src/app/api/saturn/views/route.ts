import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isUpstreamTimeout, upstreamSignal } from "../upstream-timeout";

/**
 * Proxies AI-Saturn's view (场次) list for a given project.
 *
 * Upstream: POST /project/view/loadViewList
 * The body must include at least an empty viewFilter object — the controller
 * reads the active projectId from the user's session server-side, so we don't
 * need to forward it explicitly.
 *
 * The caller's RuoYi token is passed straight through.
 */

const searchParamsSchema = z.object({
	projectId: z.coerce.number().int().positive(),
});

export async function GET(request: NextRequest) {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const parsed = searchParamsSchema.safeParse(
		Object.fromEntries(request.nextUrl.searchParams),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Missing or invalid projectId" },
			{ status: 400 },
		);
	}

	// First switch the user's active project so loadViewList picks the right one.
	//
	// This is a write, not a lookup: it moves the user's active project pointer
	// upstream. A deadline therefore buys a bounded wait, not a retry-safe one —
	// if the abort fires while the backend is still applying the switch, we
	// cannot tell whether the pointer moved, and reporting failure is the only
	// honest answer we have. The user is left looking at the old project until
	// they reload, which is the recoverable half of the trade.
	const switchUpstream = new URL(
		"/project/info/setProjectInUse",
		webEnv.SATURN_API_BASE,
	);
	switchUpstream.searchParams.set("projectId", String(parsed.data.projectId));

	try {
		const switchRes = await fetch(switchUpstream, {
			headers: { Authorization: authorization },
			cache: "no-store",
			signal: upstreamSignal(),
		});
		if (!switchRes.ok && switchRes.status !== 200) {
			return NextResponse.json(
				{ error: `Failed to switch project (${switchRes.status})` },
				{ status: switchRes.status === 401 ? 401 : 502 },
			);
		}
	} catch (error) {
		console.error("Failed to switch project on AI-Saturn:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: isUpstreamTimeout(error) ? 504 : 502 },
		);
	}

	// Now fetch the view list for the active project.
	const upstream = new URL(
		"/project/view/loadViewList",
		webEnv.SATURN_API_BASE,
	);

	try {
		const response = await fetch(upstream, {
			method: "POST",
			headers: {
				Authorization: authorization,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ viewFilter: {}, from: 1 }),
			cache: "no-store",
			signal: upstreamSignal(),
		});

		if (!response.ok) {
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		return NextResponse.json(await response.json());
	} catch (error) {
		console.error("Failed to reach AI-Saturn for view list:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: isUpstreamTimeout(error) ? 504 : 502 },
		);
	}
}
