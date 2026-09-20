import {
	saturnProjectListResponseSchema,
	saturnViewListResponseSchema,
	type SaturnProject,
	type SaturnView,
} from "./types";

/**
 * Fetches the current user's project list from AI-Saturn via the proxy route.
 */
export async function fetchSaturnProjects({
	token,
	signal,
}: {
	token: string;
	signal?: AbortSignal;
}): Promise<SaturnProject[]> {
	const response = await fetch("/api/saturn/projects", {
		headers: { Authorization: token },
		signal,
	});

	if (response.status === 401) {
		throw new Error("AI-Saturn 登录态已失效，请重新获取 token");
	}
	if (!response.ok) {
		throw new Error(`获取项目列表失败（HTTP ${response.status}）`);
	}

	const parsed = saturnProjectListResponseSchema.safeParse(
		await response.json(),
	);
	if (!parsed.success) {
		throw new Error("AI-Saturn 返回了无法解析的项目数据");
	}
	if (parsed.data.code !== 200) {
		throw new Error(parsed.data.msg || "获取项目列表失败");
	}

	// RuoYi TableDataInfo puts list in `rows`; some controllers use `data`.
	return parsed.data.rows ?? parsed.data.data ?? [];
}

/**
 * Fetches the view (场次) list for the given project from AI-Saturn.
 *
 * The proxy switches the user's active project first, then calls
 * /project/view/loadViewList, which reads the active project from the session.
 */
export async function fetchSaturnViews({
	token,
	projectId,
	signal,
}: {
	token: string;
	projectId: number;
	signal?: AbortSignal;
}): Promise<SaturnView[]> {
	const url = new URL("/api/saturn/views", window.location.origin);
	url.searchParams.set("projectId", String(projectId));

	const response = await fetch(url, {
		headers: { Authorization: token },
		signal,
	});

	if (response.status === 401) {
		throw new Error("AI-Saturn 登录态已失效，请重新获取 token");
	}
	if (!response.ok) {
		throw new Error(`获取场次列表失败（HTTP ${response.status}）`);
	}

	const parsed = saturnViewListResponseSchema.safeParse(await response.json());
	if (!parsed.success) {
		throw new Error("AI-Saturn 返回了无法解析的场次数据");
	}
	if (parsed.data.code !== 200) {
		throw new Error(parsed.data.msg || "获取场次列表失败");
	}

	// Flatten: loadViewList returns a list of series groups, each with a viewList.
	const groups = parsed.data.data?.list ?? [];
	return groups.flatMap((g) => g.viewList ?? []);
}
