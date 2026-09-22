import { ThemeProvider } from "next-themes";
import Script from "next/script";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { SaturnBrandProvider } from "@/saturn/brand-provider";
import { SaturnBrandDocument } from "@/saturn/brand-document";
import { BotIdClient } from "botid/client";
// import { webEnv } from "@/env/web"; // only read by the analytics beacon below
import { Inter } from "next/font/google";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<BotIdClient protect={protectedRoutes} />
				{process.env.NODE_ENV === "development" && (
					<>
						<Script
							src="//unpkg.com/react-scan/dist/auto.global.js"
							crossOrigin="anonymous"
							strategy="beforeInteractive"
						/>
					</>
				)}
			</head>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<SaturnBrandProvider>
							<SaturnBrandDocument />
							<Toaster />
						{/*
						  Upstream's analytics beacon, reporting to OpenCut's own
						  Databuddy account. Commented out for our deployment: it is
						  an outbound request on every page load, carrying a client
						  id that is not ours, and this is an internal tool.
						*/}
						{/* <Script
							src="https://cdn.databuddy.cc/databuddy.js"
							strategy="afterInteractive"
							async
							data-client-id="UP-Wcoy5arxFeK7oyjMMZ"
							data-disabled={webEnv.NODE_ENV === "development"}
							data-track-attributes={false}
							data-track-errors={true}
							data-track-outgoing-links={false}
							data-track-web-vitals={false}
							data-track-sessions={false}
						/> */}
						{children}
						</SaturnBrandProvider>
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
