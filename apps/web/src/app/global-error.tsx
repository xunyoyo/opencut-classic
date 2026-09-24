"use client";

/**
 * The last boundary: catches a throw in the root layout itself.
 *
 * `error.tsx` sits inside the layout, so it covers a page that fails to render
 * — but not a layout that fails, and not the providers the layout mounts. This
 * file is what covers those. It replaces the root layout entirely when it
 * renders, which is why it supplies its own `<html>` and `<body>`.
 *
 * That replacement is also why nothing is imported here. `globals.css` is
 * imported by the layout this file substitutes for, so Tailwind classes and
 * the CSS variables behind them are not guaranteed to be present — and the
 * providers (`ThemeProvider`, the brand and tooltip providers) are gone along
 * with the layout, so a `Button` or a themed class could fail for the same
 * reason it is being asked to report. Everything below is inline style and
 * plain markup, which needs nothing to be mounted first.
 */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<html lang="zh-CN">
			<body
				style={{
					margin: 0,
					padding: "4rem 1.5rem",
					fontFamily:
						"system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
					color: "#0a0a0a",
					background: "#ffffff",
				}}
			>
				<div style={{ maxWidth: "32rem", margin: "0 auto" }}>
					<h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: 0 }}>
						剪辑器无法启动
					</h1>
					<p
						style={{
							marginTop: "0.75rem",
							fontSize: "0.875rem",
							color: "#6b7280",
						}}
					>
						{error.message || "页面在加载过程中失败。"}
					</p>
					{error.digest && (
						<p
							style={{
								marginTop: "0.5rem",
								fontSize: "0.75rem",
								color: "#9ca3af",
							}}
						>
							错误编号 {error.digest}
						</p>
					)}
					<button
						onClick={reset}
						style={{
							marginTop: "1.5rem",
							padding: "0.5rem 1rem",
							fontSize: "0.875rem",
							fontWeight: 500,
							color: "#ffffff",
							background: "#0a0a0a",
							border: "none",
							borderRadius: "0.5rem",
							cursor: "pointer",
						}}
					>
						重试
					</button>
				</div>
			</body>
		</html>
	);
}
