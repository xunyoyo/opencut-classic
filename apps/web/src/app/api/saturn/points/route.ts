import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isUpstreamTimeout, upstreamSignal } from "../upstream-timeout";

/**
 * Reads the caller's 土豆 balance from AI-Saturn.
 *
 * Online transcription is billed against the same points wallet as the rest of
 * the platform, so the captions panel shows what is left before spending any.
 * The balance is only ever displayed — the deduction happens in the backend
 * when it runs the job, which is the only place it can be done atomically.
 *
 * Proxied for the same reason as the other AI-Saturn calls: no CORS upstream.
 */

const upstreamSchema = z.object({
	code: z.number(),
	msg: z.string().nullish(),
	data: z
		.object({
			currentPoints: z.number().nullish(),
			bonusPoints: z.number().nullish(),
			frozenPoints: z.number().nullish(),
			availablePoints: z.number().nullish(),
		})
		.nullish(),
});

export async function GET(request: NextRequest) {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const upstream = new URL("/points/getPoints", webEnv.SATURN_API_BASE);

	try {
		const response = await fetch(upstream, {
			headers: { Authorization: authorization },
			cache: "no-store",
			signal: upstreamSignal(),
		});

		if (!response.ok) {
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		const parsed = upstreamSchema.safeParse(await response.json());
		if (!parsed.success || parsed.data.code !== 200 || !parsed.data.data) {
			return NextResponse.json(
				{ error: parsed.success ? parsed.data.msg || "查询土豆余额失败" : "查询土豆余额失败" },
				{ status: 502 },
			);
		}

		const points = parsed.data.data;
		return NextResponse.json({
			// availablePoints is the spendable figure: current plus bonus, less
			// whatever is frozen against jobs already in flight.
			available: points.availablePoints ?? points.currentPoints ?? 0,
			frozen: points.frozenPoints ?? 0,
		});
	} catch (error) {
		console.error("Failed to reach AI-Saturn for points:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: isUpstreamTimeout(error) ? 504 : 502 },
		);
	}
}
