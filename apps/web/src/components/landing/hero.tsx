"use client";

import { Button } from "../ui/button";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import { Handlebars } from "./handlebars";
import Link from "next/link";
import { useBranding } from "@/saturn/use-branding";

/**
 * This deployment's front door.
 *
 * Upstream's hero sold OpenCut itself — "The open source video editor", a
 * beta sign-up, a star count. None of that is true here: this editor is one
 * panel of AI-Saturn, it is not open to sign-ups, and the person arriving is
 * a Saturn user who clicked through, not a passer-by to be recruited. So the
 * page states what it is and points at the projects already on this browser.
 *
 * The name comes from `useBranding` rather than SITE_INFO so an agency site
 * that jumped in here sees its own brand, not the platform's.
 */
export function Hero() {
	const { siteName } = useBranding();

	return (
		<div className="flex min-h-[calc(100svh-4.5rem)] flex-col items-center justify-between px-4 text-center">
			<Image
				className="absolute top-0 left-0 -z-50 size-full object-cover opacity-85 invert dark:invert-0"
				src="/landing-page-dark.png"
				height={1903.5}
				width={1269}
				alt=""
				aria-hidden
			/>
			<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center">
				<div className="inline-block text-4xl font-bold tracking-tighter md:text-[4rem]">
					<h1>{siteName}</h1>
					<Handlebars>精剪时间线</Handlebars>
				</div>

				<div className="mt-8 flex justify-center gap-8">
					<Link href="/projects">
						<Button type="submit" size="lg" className="h-11 text-base">
							开始剪辑
							<ArrowRight className="ml-0.5" />
						</Button>
					</Link>
				</div>
			</div>
		</div>
	);
}
