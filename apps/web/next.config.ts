import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const nextConfig: NextConfig = {
	compiler: {
		// Strips console output in production, but keeps `warn` and `error`.
		//
		// The bare boolean this started as removed *every* method, `warn` and
		// `error` included — so the one line that explained a degraded renderer
		// (`GPU renderer unavailable: <reason>` in gpu-renderer.ts) was deleted
		// from the build that shipped it. A user hitting that failure saw a
		// spinner and a console holding a single unrelated WASM error, with the
		// actual reason nowhere on the page or in DevTools.
		//
		// Only the object form can exclude anything; Next never injects a
		// default. `log`/`info`/`debug` stay stripped — this is not about
		// debugging convenience, it is about failures leaving a trace.
		removeConsole: process.env.NODE_ENV === "production"
			? { exclude: ["error", "warn"] }
			: false,
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));
