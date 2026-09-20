import { z } from "zod";
import { readSaturnToken } from "@/saturn/session";

/**
 * The caller's 土豆 balance, as the captions panel shows it before running an
 * online transcription.
 */
export interface SaturnPoints {
	available: number;
	frozen: number;
}

const pointsSchema = z.object({
	available: z.number(),
	frozen: z.number(),
});

/**
 * Returns null rather than throwing when the balance cannot be read.
 *
 * A missing balance should not stop anyone transcribing: the backend is what
 * actually enforces the charge, and refusing to proceed because a display
 * figure failed to load would be the wrong call.
 */
export async function fetchSaturnPoints({
	signal,
}: {
	signal?: AbortSignal;
} = {}): Promise<SaturnPoints | null> {
	const token = readSaturnToken();
	if (!token) return null;

	try {
		const response = await fetch("/api/saturn/points", {
			headers: { Authorization: token },
			signal,
		});
		if (!response.ok) return null;

		const parsed = pointsSchema.safeParse(await response.json());
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
