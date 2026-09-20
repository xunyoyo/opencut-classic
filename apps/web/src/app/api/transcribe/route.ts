import { webEnv } from "@/env/web";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

/**
 * Submits timeline audio to AI-Saturn for transcription, and polls the result.
 *
 * Proxied for the same reason as the other AI-Saturn calls: no CORS upstream.
 * The caller's RuoYi token is relayed unchanged, so 土豆 are charged against
 * whoever is actually signed in.
 *
 * The POST returns the id of a long-request log row rather than the captions,
 * and the client polls that row — the backend's existing convention for work
 * too slow to answer inline. docs/saturn-transcription.md is the contract.
 */

const submitSchema = z.object({
	code: z.number(),
	msg: z.string().nullish(),
	data: z.union([z.number(), z.string()]).nullish(),
	points: z.number().nullish(),
});

const pollSchema = z.object({
	code: z.number(),
	msg: z.string().nullish(),
	data: z
		.object({
			status: z.number().nullish(),
			result: z.string().nullish(),
		})
		.nullish(),
});

const innerSchema = z.object({
	code: z.number(),
	msg: z.string().nullish(),
	data: z
		.object({
			language: z.string().nullish(),
			text: z.string().nullish(),
			segments: z
				.array(
					z.object({
						text: z.string(),
						start: z.number(),
						end: z.number(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

const FINISHED = 1;

function requireAuth(request: NextRequest): string | null {
	return request.headers.get("authorization");
}

export async function POST(request: NextRequest) {
	const authorization = requireAuth(request);
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const incoming = await request.formData();
	const file = incoming.get("file");
	if (!(file instanceof Blob)) {
		return NextResponse.json({ error: "Missing audio file" }, { status: 400 });
	}

	const language = incoming.get("language");
	const outgoing = new FormData();
	outgoing.append("file", file, "timeline.wav");
	outgoing.append("language", typeof language === "string" ? language : "auto");

	const upstream = new URL(
		webEnv.SATURN_TRANSCRIBE_PATH,
		webEnv.SATURN_API_BASE,
	);

	try {
		const response = await fetch(upstream, {
			method: "POST",
			headers: { Authorization: authorization },
			body: outgoing,
			cache: "no-store",
		});

		if (!response.ok) {
			return NextResponse.json(
				{ error: `AI-Saturn returned ${response.status}` },
				{ status: response.status === 401 ? 401 : 502 },
			);
		}

		const parsed = submitSchema.safeParse(await response.json());
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Unrecognised response from AI-Saturn" },
				{ status: 502 },
			);
		}

		const { code, msg, data, points } = parsed.data;
		if (code !== 200 || data == null) {
			// Carries through 土豆不足，请充值 and anything else the backend rejects
			// with, which is more use to the user than a generic failure.
			return NextResponse.json(
				{ error: msg || "提交转录任务失败" },
				{ status: 502 },
			);
		}

		return NextResponse.json({ reqId: String(data), points: points ?? null });
	} catch (error) {
		console.error("Failed to submit transcription to AI-Saturn:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}

export async function GET(request: NextRequest) {
	const authorization = requireAuth(request);
	if (!authorization) {
		return NextResponse.json(
			{ error: "Missing Authorization header" },
			{ status: 401 },
		);
	}

	const id = request.nextUrl.searchParams.get("id");
	if (!id) {
		return NextResponse.json({ error: "Missing id" }, { status: 400 });
	}

	const upstream = new URL(
		webEnv.SATURN_TRANSCRIBE_POLL_PATH,
		webEnv.SATURN_API_BASE,
	);
	upstream.searchParams.set("id", id);

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

		const parsed = pollSchema.safeParse(await response.json());
		if (!parsed.success || parsed.data.code !== 200 || !parsed.data.data) {
			return NextResponse.json(
				{ error: parsed.success ? parsed.data.msg || "轮询失败" : "轮询失败" },
				{ status: 502 },
			);
		}

		const row = parsed.data.data;
		if (row.status !== FINISHED || !row.result) {
			return NextResponse.json({ done: false });
		}

		// status 1 only means the job stopped. Whether it worked is in the
		// AjaxResult serialised into `result`.
		let inner: unknown;
		try {
			inner = JSON.parse(row.result);
		} catch {
			return NextResponse.json(
				{ done: true, error: "转录结果无法解析" },
				{ status: 200 },
			);
		}

		const innerParsed = innerSchema.safeParse(inner);
		if (!innerParsed.success) {
			return NextResponse.json({ done: true, error: "转录结果无法解析" });
		}

		if (innerParsed.data.code !== 200 || !innerParsed.data.data) {
			return NextResponse.json({
				done: true,
				error: innerParsed.data.msg || "转录失败",
			});
		}

		const payload = innerParsed.data.data;
		const segments = payload.segments ?? [];
		return NextResponse.json({
			done: true,
			language: payload.language ?? "auto",
			text: payload.text ?? segments.map((segment) => segment.text).join(""),
			segments,
		});
	} catch (error) {
		console.error("Failed to poll AI-Saturn for transcription:", error);
		return NextResponse.json(
			{ error: "Failed to reach AI-Saturn" },
			{ status: 502 },
		);
	}
}
