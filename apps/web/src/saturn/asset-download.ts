/**
 * Downloads one AI-Saturn asset through the editor's own proxy.
 *
 * The bytes have to come through `/api/saturn/asset` rather than straight from
 * the CDN: the bucket sends no CORS headers, so a cross-origin `fetch` from the
 * editor origin is blocked. Relaying it makes the request same-origin.
 *
 * Shared by the media importer and the placeholder replacement so the URL
 * construction and the error shape stay in one place.
 */
export async function downloadSaturnAsset({
	url,
	name,
	signal,
}: {
	url: string;
	name: string;
	signal?: AbortSignal;
}): Promise<File> {
	const proxyUrl = new URL("/api/saturn/asset", window.location.origin);
	proxyUrl.searchParams.set("url", url);

	const response = await fetch(proxyUrl, { signal });
	if (!response.ok) {
		throw new Error(`下载素材失败（HTTP ${response.status}）`);
	}

	const blob = await response.blob();
	return new File([blob], name, { type: blob.type || "video/mp4" });
}
