import { webEnv } from "@/env/web";
import {
	SESSION_COOKIE_NAME,
	sealSession,
	sessionCookieOptions,
} from "@/saturn/session-cookie";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

/**
 * Exchanges an AI-Saturn token for the editor's own session cookie.
 *
 * This is the one place the token is actually checked against the platform.
 * The gate in `proxy.ts` only verifies the cookie's signature, which says the
 * cookie was minted here — not that the token inside it still works. Asking
 * the backend on every navigation would put a round trip in front of every
 * RSC prefetch and make the platform's uptime a hard dependency of the
 * editor's routing, so validation happens exactly once, on the way in.
 *
 * A token that was valid when it was minted can still be revoked before the
 * cookie expires; that is what the 7-day lifetime in `session-cookie.ts`
 * bounds. It is a deliberate trade: a shorter life costs the user a re-entry,
 * a longer one costs a stale session.
 *
 * Proxied rather than called from the browser for the same reason as the
 * other AI-Saturn calls — there is no CORS upstream.
 */

/**
 * `/getInfo` is the cheapest endpoint that answers "is this token good": it
 * returns the caller's own identity and needs no arguments. `/system/user/profile`
 * returns more than is needed here.
 */
const IDENTITY_PATH = "/getInfo";

/**
 * RuoYi reports an authentication failure as **HTTP 200** with `code: 401` in
 * the body, so `response.ok` is true for a bad token and cannot be the check.
 * The body is the only reliable signal — the same shape `points/route.ts`
 * reads for the same reason.
 */
const identitySchema = z.object({
	code: z.number(),
});

/**
 * How long to wait on the platform before giving up and calling it unreachable.
 *
 * A bounded wait, not a nicety: this call sits between the user and the editor,
 * so an upstream that accepts the connection and then never answers would leave
 * them on 「正在校验登录态…」 with no failure card and nothing to retry. Ten
 * seconds is well past a healthy response and well short of a person's patience.
 */
const IDENTITY_TIMEOUT_MS = 10_000;

export async function POST(request: NextRequest) {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return NextResponse.json(
			{ error: "缺少登录态，请从 AI-Saturn 重新进入" },
			{ status: 401 },
		);
	}

	let response: Response;
	try {
		response = await fetch(new URL(IDENTITY_PATH, webEnv.SATURN_API_BASE), {
			headers: { Authorization: authorization },
			cache: "no-store",
			signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
		});
	} catch (error) {
		// Could not reach the platform at all. Distinct from "the platform said
		// no": nothing is known about the token, so no cookie is minted and the
		// caller is told the difference — one is a retry, the other a re-login.
		console.error("Failed to reach AI-Saturn to validate session:", error);
		return NextResponse.json(
			{ error: "无法连接 AI-Saturn，请稍后重试" },
			{ status: 503 },
		);
	}

	if (response.status === 401) {
		return NextResponse.json(
			{ error: "登录态已失效，请从 AI-Saturn 重新进入" },
			{ status: 401 },
		);
	}

	if (!response.ok) {
		return NextResponse.json(
			{ error: `AI-Saturn 返回 ${response.status}` },
			{ status: 502 },
		);
	}

	const parsed = identitySchema.safeParse(await response.json());
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "AI-Saturn 返回了无法识别的结果" },
			{ status: 502 },
		);
	}

	if (parsed.data.code !== 200) {
		// Deliberately not `parsed.data.msg`: RuoYi's own wording names the
		// internal endpoint that refused, which is no use to the user and not
		// ours to hand out.
		return NextResponse.json(
			{ error: "登录态已失效，请从 AI-Saturn 重新进入" },
			{ status: 401 },
		);
	}

	// Verified. The header carries a scheme prefix ("Bearer <token>") and that
	// is what upstream expects on every later call, so the whole value is what
	// gets sealed — stripping it here would mean rebuilding it in more places.
	const sealed = sealSession({ token: authorization });
	if (!sealed) {
		// No SATURN_SESSION_SECRET. Failing loudly beats minting a cookie the
		// gate cannot verify, which would look to the user like a login loop.
		console.error(
			"SATURN_SESSION_SECRET is not set; cannot mint an editor session",
		);
		return NextResponse.json(
			{ error: "服务端未配置会话密钥，请联系管理员" },
			{ status: 500 },
		);
	}

	const result = NextResponse.json({ ok: true });
	result.cookies.set(SESSION_COOKIE_NAME, sealed, sessionCookieOptions());
	return result;
}
