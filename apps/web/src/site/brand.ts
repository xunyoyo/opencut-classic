// This deployment's own identity, used wherever an AI-Saturn deployment has not
// supplied one. It is what a tab says before the brand arrives from the URL,
// and what every unbranded visitor sees.
//
// The name matches the platform it is reached from rather than the upstream
// project — this editor ships inside AI-Saturn, and calling it by its upstream
// name in a user's tab bar would be wrong on every page.
export const SITE_URL = "https://saturndf.xiaotuxp.com";

export const SITE_INFO = {
	title: "AI-Saturn 剪辑",
	description: "剪出你的短剧。浏览器里直接剪，成片从 AI-Saturn 项目直接拖进来。",
	url: SITE_URL,
	openGraphImage: "/open-graph/default.jpg",
	twitterImage: "/open-graph/default.jpg",
	favicon: "/favicon.ico",
};

// The mark used when nothing upstream supplied one. Square, transparent, and
// drawn in a single colour so `invert dark:invert-0` works on it the same way
// it did on the SVG it replaces.
export const DEFAULT_LOGO_URL = "/logos/saturn/symbol.png";
