"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * The error boundary this app did not have.
 *
 * Without one, a throw during render — or inside an effect in a page with no
 * boundary above it — reaches React's default handler, which in a production
 * build reports the error and tears the tree down. What the user is left with
 * is a blank page: no message, no retry, and nothing in the console beyond
 * whatever the throw itself printed. The renderer downgrade work
 * (`a425d3aa`) was written specifically because a GPU failure was reaching
 * the page this way, and its own commit message notes the app had no
 * `error.tsx` for the exception to be caught by.
 *
 * Deliberately outside the editor's own UI: this can fire before any editor
 * state exists — while the storage layer is still opening, say — so it must
 * not depend on a provider being mounted. It reads only `error` and
 * `reset`, and styles itself the way `PrepScreen` does.
 *
 * `error.message` is shown rather than a fixed string. This is an internal
 * tool, the reader is the person who can act on it, and a generic "出错了"
 * would reproduce the exact problem this file exists to fix: a failure with
 * no visible cause. `digest` is included because it is the only way to match
 * a client-side error to the server log line that produced it.
 */
export default function Error({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		// Survives the console stripping in next.config.ts, which now keeps
		// `error` and `warn` precisely so a failure like this leaves a trace.
		console.error("Unhandled error reached the app boundary:", error);
	}, [error]);

	return (
		<div className="mx-auto max-w-lg px-6 py-16">
			<h1 className="text-xl font-semibold">剪辑器出错了</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				{error.message || "页面遇到未预期的错误。"}
			</p>
			{error.digest && (
				<p className="mt-2 text-xs text-muted-foreground">
					错误编号 {error.digest}
				</p>
			)}
			<div className="mt-6 flex gap-3">
				<Button onClick={reset}>重试</Button>
				{/* A reload is the only thing that clears a wedged storage or
				    GPU state; `reset` re-renders but keeps the same runtime. */}
				<Button variant="outline" onClick={() => window.location.reload()}>
					刷新页面
				</Button>
			</div>
		</div>
	);
}
