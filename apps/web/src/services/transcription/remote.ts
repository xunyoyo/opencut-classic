import { z } from "zod";
import { readSaturnToken } from "@/saturn/session";
import type {
	TranscriptionLanguage,
	TranscriptionProgress,
	TranscriptionResult,
} from "@/transcription/types";

/**
 * Transcribes through AI-Saturn instead of the in-browser Whisper worker.
 *
 * Submit then poll, following the backend's convention for expensive AI work:
 * the POST returns a long-request id and the row is polled until it finishes.
 *
 * This path posts the wav straight from the timeline. Unlike the local engine
 * it never decodes to Float32 samples, which is both the slowest main-thread
 * step in the pipeline and pointless work when the server wants a file.
 */

const submitSchema = z.object({
	reqId: z.string(),
	points: z.number().nullish(),
});

const pollSchema = z.object({
	done: z.boolean(),
	error: z.string().nullish(),
	language: z.string().nullish(),
	text: z.string().nullish(),
	segments: z
		.array(z.object({ text: z.string(), start: z.number(), end: z.number() }))
		.nullish(),
});

const errorSchema = z.object({ error: z.string() });

const POLL_INTERVAL_MS = 2000;
// Generous: a long timeline takes a while, and the backend frees the frozen
// 土豆 on its own through PointsCompensationJob if the job never lands.
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

const EXPIRED_SESSION = "AI-Saturn登录态已失效，请从后端重新打开本页面";

async function readError(response: Response): Promise<string | null> {
	const parsed = await response
		.json()
		.then((payload: unknown) => errorSchema.safeParse(payload))
		.catch(() => null);
	return parsed?.success ? parsed.data.error : null;
}

function sleep({
	ms,
	signal,
}: {
	ms: number;
	signal?: AbortSignal;
}): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("转录已取消"));
			},
			{ once: true },
		);
	});
}

export async function transcribeRemote({
	audioBlob,
	language = "auto",
	onProgress,
	signal,
}: {
	audioBlob: Blob;
	language?: TranscriptionLanguage;
	onProgress?: (progress: TranscriptionProgress) => void;
	signal?: AbortSignal;
}): Promise<TranscriptionResult> {
	const token = readSaturnToken();
	if (!token) {
		throw new Error("未找到AI-Saturn登录态，请从后端重新打开本页面");
	}

	const body = new FormData();
	body.append("file", audioBlob, "timeline.wav");
	body.append("language", language);

	onProgress?.({ status: "transcribing", progress: 0, message: "提交转录任务" });

	const submitResponse = await fetch("/api/transcribe", {
		method: "POST",
		headers: { Authorization: token },
		body,
		signal,
	});

	if (!submitResponse.ok) {
		if (submitResponse.status === 401) throw new Error(EXPIRED_SESSION);
		throw new Error((await readError(submitResponse)) ?? "提交转录任务失败");
	}

	const submitted = submitSchema.safeParse(await submitResponse.json());
	if (!submitted.success) {
		throw new Error("提交转录任务返回了无法识别的结果");
	}

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep({ ms: POLL_INTERVAL_MS, signal });

		const pollResponse = await fetch(
			`/api/transcribe?id=${encodeURIComponent(submitted.data.reqId)}`,
			{ headers: { Authorization: token }, signal },
		);

		if (!pollResponse.ok) {
			if (pollResponse.status === 401) throw new Error(EXPIRED_SESSION);
			throw new Error((await readError(pollResponse)) ?? "查询转录进度失败");
		}

		const polled = pollSchema.safeParse(await pollResponse.json());
		if (!polled.success) {
			throw new Error("查询转录进度返回了无法识别的结果");
		}
		if (!polled.data.done) {
			onProgress?.({ status: "transcribing", progress: 0, message: "转录中" });
			continue;
		}
		if (polled.data.error) {
			throw new Error(polled.data.error);
		}

		onProgress?.({ status: "complete", progress: 100 });
		const segments = polled.data.segments ?? [];
		return {
			language: polled.data.language ?? "auto",
			text: polled.data.text ?? segments.map((s) => s.text).join(""),
			segments,
		};
	}

	throw new Error("转录超时，请稍后在后端查看任务状态");
}
