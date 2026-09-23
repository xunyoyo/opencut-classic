import { z } from "zod";

const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
	NEXT_PUBLIC_MARBLE_API_URL: z.url(),

	// Where Whisper weights are downloaded from. Declared here as the single
	// place env vars are documented, but the transcription worker reads them
	// straight off process.env — it cannot import this module, which parses the
	// server-side schema. Point these at your own bucket to stop depending on a
	// public mirror.
	NEXT_PUBLIC_TRANSCRIPTION_MODEL_HOST: z
		.url()
		.default("https://hf-mirror.com/"),
	NEXT_PUBLIC_TRANSCRIPTION_MODEL_PATH_TEMPLATE: z.string().optional(),

	// Where webfont stylesheets are loaded from. fonts.googleapis.com and
	// Google's own fonts.googleapis.cn mirror are both unreachable from the
	// mainland, so point this at a bucket holding one rewritten stylesheet per
	// family. Setting it also narrows the picker to the mirrored families —
	// offering the full atlas would just be a list of fonts that cannot load.
	// Read off process.env rather than through this module, same as the model
	// host above.
	NEXT_PUBLIC_FONT_CSS_BASE: z.url().optional(),

	// Server
	DATABASE_URL: z.string().refine(
		(url) =>
			url.startsWith("postgres://") || url.startsWith("postgresql://"),
		"DATABASE_URL must be a postgres:// or postgresql:// URL",
	),

	BETTER_AUTH_SECRET: z.string(),
	UPSTASH_REDIS_REST_URL: z.url(),
	UPSTASH_REDIS_REST_TOKEN: z.string(),
	MARBLE_WORKSPACE_KEY: z.string(),
	FREESOUND_CLIENT_ID: z.string(),
	FREESOUND_API_KEY: z.string(),

	// AI-Saturn integration. Both default so existing deployments keep booting
	// without new env vars; only the import route reads them.
	SATURN_API_BASE: z.url().default("http://localhost:8080"),
	// Signs the editor's own session cookie. Registered here because this schema
	// is the inventory of what a deployment needs, but the proxy and the session
	// route read `process.env` directly — importing this module would parse the
	// whole schema and drag zod into the proxy bundle for one string.
	//
	// Not defaulted to a real value: a shared fallback would make every
	// deployment that forgot to set it accept cookies minted by every other
	// deployment that forgot too. Absent means the gate admits nobody, which is
	// the safe direction to fail, and `/api/saturn/session` says so explicitly.
	SATURN_SESSION_SECRET: z.string().optional(),
	// Comma-separated allowlist for the asset proxy. Without it the proxy would
	// fetch any URL the caller supplies, which is an SSRF hole.
	SATURN_ASSET_HOSTS: z
		.string()
		.default(
			"cdn-saturndf.xiaotuxp.com,saturndf-oss.oss-cn-beijing.aliyuncs.com",
		),
	// Origin every asset URL is rewritten onto before it leaves our server.
	//
	// `store_path` is a snapshot of whatever domain was configured at upload
	// time, so the same bucket is addressed through several hosts: uploads
	// before September 2026 are on the raw OSS endpoint, later ones on the CDN.
	// Both resolve to the same object, and which one to serve is a hosting
	// decision rather than a property of the file — so it belongs here, at the
	// boundary, instead of being baked into the database or the stored
	// timeline. Empty means "leave upstream URLs alone".
	SATURN_ASSET_PUBLIC_BASE: z
		.string()
		.default("https://cdn-saturndf.xiaotuxp.com"),
	// AI-Saturn's transcription endpoint, relative to SATURN_API_BASE. Only the
	// proxy route reads it; the flag below is what the browser sees, since the
	// path itself is no business of the client's.
	SATURN_TRANSCRIBE_PATH: z.string().default("/project/media/transcribe"),
	// Polling reuses the generic long-request row reader, which is what the
	// backend's other async AI operations are polled through.
	SATURN_TRANSCRIBE_POLL_PATH: z
		.string()
		.default("/project/analysis/reqResultPoll"),
	NEXT_PUBLIC_TRANSCRIPTION_REMOTE_ENABLED: z
		.enum(["true", "false"])
		.default("false"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
